import mysql from "mysql2/promise";

export const mysqlHost =
  process.env.MYSQL_HOST ?? process.env.NEXT_PUBLIC_MYSQL_HOST ?? "localhost";
const parsedPort = Number(process.env.MYSQL_PORT ?? 3306);
export const mysqlPort =
  Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3306;
export const mysqlDatabase =
  process.env.MYSQL_DATABASE ?? process.env.NEXT_PUBLIC_MYSQL_DATABASE ?? "";
export const mysqlUser =
  process.env.MYSQL_USER ?? process.env.NEXT_PUBLIC_MYSQL_USER ?? "";
const mysqlPassword =
  process.env.MYSQL_PASSWORD ?? process.env.NEXT_PUBLIC_MYSQL_PASSWORD ?? "";

export const isMysqlConfigured =
  mysqlDatabase.length > 0 &&
  mysqlUser.length > 0 &&
  mysqlHost.length > 0;

let pool: mysql.Pool | null = null;

export function getMysqlPool(): mysql.Pool | null {
  if (!isMysqlConfigured) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: mysqlHost,
      port: mysqlPort,
      database: mysqlDatabase,
      user: mysqlUser,
      password: mysqlPassword,
      // Optimized for Vercel serverless + remote Azure MySQL: allow a few
      // more concurrent connections so parallel admin fetches don't queue,
      // release idle ones fast to respect the small server max_connections.
      connectionLimit: 8,
      maxIdle: 4,
      idleTimeout: 15_000,
      connectTimeout: 10_000,
      waitForConnections: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 5_000,
      queueLimit: 100,
      // Self-hosted MariaDB is non-TLS (managed Azure MySQL enforces TLS).
      // Set MYSQL_SSL=false for self-hosted/local, MYSQL_SSL=true to force TLS.
      ssl:
        process.env.MYSQL_SSL === "false"
          ? undefined
          : /azure\.com$/.test(mysqlHost) || process.env.MYSQL_SSL === "true"
            ? { rejectUnauthorized: false }
            : undefined,
      flags: ["FOUND_ROWS"],
      // App writes DATETIME/TIMESTAMP as UTC strings and the DB session is UTC;
      // parse reads as UTC too. Without this, a non-UTC host (e.g. +06 dev box)
      // shifts every read by its offset and exam attempts look instantly expired.
      timezone: "Z",
    });
    // Prevent unhandled 'error' events on idle connections from crashing Node.
    (pool as unknown as { on?: (e: string, l: () => void) => void }).on?.(
      "error",
      () => {},
    );
  }
  return pool;
}

// Retry once on transient connection failures (serverless idle kills, failover).
function isTransientDbError(code?: string): boolean {
  return (
    code === "ER_CON_COUNT_ERROR" ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
}

/**
 * A connection can drop AFTER the server committed a write (lost ACK). Only
 * statements that are safe to repeat may be retried; a blind retry of a plain
 * INSERT (or a counter UPDATE) would silently duplicate/double-apply it.
 */
function isRetrySafeWrite(sql: string): boolean {
  const text = sql.trim().replace(/\s+/g, " ");
  const upper = text.toUpperCase();
  if (/^(CREATE|ALTER|DROP|DELETE|REPLACE|SET|TRUNCATE)\b/.test(upper)) return true;
  if (upper.startsWith("INSERT")) {
    return /^INSERT\s+IGNORE\b/.test(upper) || upper.includes("ON DUPLICATE KEY UPDATE");
  }
  if (upper.startsWith("UPDATE")) {
    // `col = col + 1` style updates are not idempotent.
    return !/\b(\w+)`?\s*=\s*`?\1`?\s*[-+*/]/i.test(text);
  }
  return false;
}

// Simple in-memory query cache for GET requests (invalidated on mutations).
// Bounded LRU: evicts the oldest entry once full so long-lived serverless
// instances never grow memory unboundedly.
const queryCache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL = 5_000; // 5 seconds default
const CACHE_MAX_ENTRIES = 500;

function cacheKey(sql: string, params?: unknown[]): string {
  return sql + "|" + JSON.stringify(params ?? []);
}

function cacheSet(key: string, data: unknown, expires: number): void {
  if (queryCache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order — delete the oldest entry.
    const oldest = queryCache.keys().next();
    if (!oldest.done) queryCache.delete(oldest.value);
  }
  queryCache.set(key, { data, expires });
}

export async function query<T>(
  sql: string,
  params?: unknown[],
  options?: { cache?: number | false },
): Promise<T> {
  const client = getMysqlPool();
  if (!client) throw new Error("Database is not configured.");

  // Cache GET queries (SELECT) by default. Locking reads and
  // information_schema introspection are never cached.
  const upper = sql.trim().toUpperCase();
  const useCache =
    options?.cache !== false &&
    upper.startsWith("SELECT") &&
    !upper.includes("FOR UPDATE") &&
    !upper.includes("INFORMATION_SCHEMA");
  const ttl = typeof options?.cache === "number" ? options.cache : CACHE_TTL;
  // Build key defensively: BigInt/circular params throw in JSON.stringify —
  // bypass cache instead of crashing outside the retry loop.
  let key = "";
  let cacheable = useCache;
  try {
    key = cacheKey(sql, params);
  } catch {
    cacheable = false;
  }

  if (cacheable) {
    const cached = queryCache.get(key);
    if (cached && cached.expires > Date.now()) {
      // Refresh LRU position on hit.
      queryCache.delete(key);
      queryCache.set(key, cached);
      return cached.data as T;
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // NOTE: pool.query (text protocol) instead of pool.execute (binary
      // prepare). Against remote Azure MySQL every prepared statement costs
      // an extra PREPARE round-trip over WAN latency — query() halves the
      // round-trips per statement. Placeholders are still safely escaped.
      const [rows] = await client.query(sql, params as never);
      if (cacheable) {
        cacheSet(key, rows, Date.now() + ttl);
      }
      return rows as T;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (isTransientDbError(code) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

// Invalidate cache on mutations
export function invalidateQueryCache(pattern?: string): void {
  if (!pattern) {
    queryCache.clear();
    return;
  }
  for (const k of queryCache.keys()) {
    if (k.includes(pattern)) queryCache.delete(k);
  }
}

export async function exec(
  sql: string,
  params?: unknown[],
): Promise<mysql.ResultSetHeader> {
  const client = getMysqlPool();
  if (!client) throw new Error("Database is not configured.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [result] = await client.query<mysql.ResultSetHeader>(sql, params as never);
      // Invalidate relevant cache on write
      const tableMatch = sql.match(/\b(INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO\s+)?`?(\w+)`?/i);
      if (tableMatch) invalidateQueryCache(tableMatch[2]);
      return result;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (isTransientDbError(code) && attempt === 0 && isRetrySafeWrite(sql)) {
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

/**
 * MySQL-safe "add column if missing". MariaDB's `ADD COLUMN IF NOT EXISTS`
 * is not supported by Azure MySQL, so callers self-heal through this instead.
 * `definition` includes the column name, e.g. "`title` VARCHAR(255) NULL".
 */
export async function ensureColumn(
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const rows = await query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  );
  if ((rows[0]?.n ?? 0) > 0) return;
  // DDL is inherently unescaped — reject anything containing statement
  // separators/quotes-backticks outside a controlled charset so a future
  // caller can't smuggle a second statement or identifier into `definition`.
  if (!/^[A-Za-z0-9_()\s,.'"`:+\-]*$/.test(definition)) {
    throw new Error("Unsafe column definition.");
  }
  const safeTable = "`" + table.replace(/`/g, "``") + "`";
  await exec(`ALTER TABLE ${safeTable} ADD COLUMN ${definition}`);
}

/**
 * Run a set of statements in a single MySQL transaction — all succeed or
 * all roll back. The connection is row-locked work's own (use
 * `SELECT ... FOR UPDATE` inside for concurrent-safety).
 */
export async function withTransaction<T>(
  work: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const client = getMysqlPool();
  if (!client) {
    throw new Error("Database is not configured.");
  }
  const connection = await client.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    invalidateQueryCache();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* connection already broken */
    }
    throw error;
  } finally {
    connection.release();
  }
}

export function parseDate(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
  }
  return "";
}

/**
 * Normalize a JSON column value. mysql2 auto-parses JSON columns into
 * objects/arrays, but values may also arrive as strings (raw drivers,
 * legacy rows), so accept both and never throw.
 */
export function parseJsonColumn<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}