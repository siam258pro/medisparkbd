"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  findActiveAdminNav,
} from "@/lib/admin-nav";
import {
  CloseIcon,
  DashboardIcon,
  MenuIcon,
  SearchIcon,
  NotificationsIcon,
  SettingsIcon,
  LogoutIcon,
  WebsiteIcon,
  PanelLeftIcon,
  CoursesIcon,
  BookOpenIcon,
  ExamsIcon,
  FaqIcon,
  StudentsIcon,
  EnrollmentsIcon,
  MegaphoneIcon,
  UserShieldIcon,
  ResultsChartIcon,
  HomeIcon,
} from "@/components/admin/icons";
import { AdminThemeProvider, useAdminTheme } from "@/components/admin/AdminThemeProvider";
import AdminThemeToggle from "@/components/admin/AdminThemeToggle";
import AdminToastProvider from "@/components/admin/AdminToastProvider";
import AdminSearch from "@/components/admin/AdminSearch";
import { hasControlAccess, useAdminGate } from "@/components/admin/admin-ui";
import { useAuth } from "@/lib/auth-context";
import { useOverlayBackClose } from "@/components/navigation/useOverlayBackClose";

const SIDEBAR_STORAGE_KEY = "medispark-admin-sidebar-collapsed";

/** Latest-activity row shape served by GET /api/admin/activity/recent. */
type RecentActivity = {
  id: number;
  adminEmail: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

/** Pending enrollment request waiting for admin approval. */
type PendingItem = {
  id: number;
  studentName: string;
  courseId: string;
  courseName: string;
  courseKind: "free" | "paid";
  fee: number;
  createdAt: number | null;
};

/** "course.save" → "Course save" for the bell list. */
function formatActivityAction(action: string): string {
  const text = action.replace(/[._-]+/g, " ").trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : "Activity";
}

function timeAgo(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Epoch-ms variant for pending items (null → no timestamp). */
function timeAgoMs(epochMs: number | null): string {
  if (!epochMs) return "waiting review";
  return timeAgo(new Date(epochMs).toISOString());
}

// === Required sidebar structure: HOME separate + MANAGEMENT heading + Home Page Control after Enrollment ===
const ADMIN_NAV = [
  { label: "HOME", href: "/admin", icon: DashboardIcon },
  { label: "Website Control", href: "/admin/website-information", icon: WebsiteIcon },
  { label: "Enrollment Control", href: "/admin/enrollment-control", icon: EnrollmentsIcon },
  { label: "Home Page Control", href: "/admin/home-control", icon: HomeIcon },
  { label: "Course Control", href: "/admin/course-control", icon: CoursesIcon },
  { label: "Course Content Control", href: "/admin/course-content-control", icon: BookOpenIcon },
  { label: "Material PDF Generator", href: "/admin/material-pdf", icon: ExamsIcon },
  { label: "Free Exam Control", href: "/admin/public-exam-control", icon: ExamsIcon },
  { label: "Exam Rules", href: "/admin/exam-rules", icon: ExamsIcon },
  { label: "Paste Format", href: "/admin/exam-paste-format", icon: ExamsIcon },
  { label: "Q&A Control", href: "/admin/qa-control", icon: FaqIcon },
  { label: "Dashboard Control", href: "/admin/dashboard-control", icon: DashboardIcon },
  { label: "Student Control", href: "/admin/student-control", icon: StudentsIcon },
  { label: "Result Control", href: "/admin/result-control", icon: ResultsChartIcon },
  { label: "Result Board", href: "/admin/result-control/board", icon: ResultsChartIcon },
  { label: "Notification Control", href: "/admin/notification-control", icon: MegaphoneIcon },
  { label: "Readme", href: "/admin/rules", icon: BookOpenIcon },
  { label: "Admin Center", href: "/admin/admin-center", icon: UserShieldIcon },
] as const;

export default function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <AdminThemeProvider>
      <AdminShellInner>{children}</AdminShellInner>
    </AdminThemeProvider>
  );
}

function AdminShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme } = useAdminTheme();
  const gate = useAdminGate();
  const { user, logout: signOut } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
/** Map an activity action to the admin page that owns it (click → redirect). */
function activityHref(action: string): string {
  const a = action.toLowerCase();
  if (/enroll|payment|coupon|fee/.test(a)) return "/admin/enrollment-control";
  if (/result|ranking|leaderboard/.test(a)) return "/admin/result-control";
  if (/public.?exam/.test(a)) return "/admin/public-exam-control";
  if (/exam|question|answer.?key|rule/.test(a)) return "/admin/public-exam-control";
  if (/material|pdf|chapter|content|course/.test(a)) return "/admin/course-control";
  if (/student|profile/.test(a)) return "/admin/student-control";
  if (/qa|question.*answer/.test(a)) return "/admin/qa-control";
  if (/notif|push|announce/.test(a)) return "/admin/notification-control";
  if (/admin|role|staff|moderator|teacher|activity|audit|log/.test(a)) return "/admin/admin-center";
  if (/finance|cost|income|audit/.test(a)) return "/finance";
  if (/home|banner|hero|review|faq/.test(a)) return "/admin/home-control";
  if (/website|theme|navbar|seo|logo|mentor|footer|setting/.test(a)) return "/admin/website-information";
  if (/dashboard/.test(a)) return "/admin/dashboard-control";
  return "/admin/administration/activity-logs";
}

const NOTIF_READ_KEY = "medispark-admin-notif-read";

function loadReadIds(): number[] {
  try {
    const raw = window.localStorage.getItem(NOTIF_READ_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    // Normalize through Number() — server ids may arrive as strings and a
    // strict includes() would then never match, leaving the badge stuck.
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => Number(v))
      .filter((n): n is number => Number.isFinite(n));
  } catch {
    return [];
  }
}

  // Notification bell — recent admin activity feed.
  const notifRef = useRef<HTMLDivElement>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifItems, setNotifItems] = useState<RecentActivity[]>([]);
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  // Per-admin read state (localStorage) — audit rows are never deleted,
  // checking a notification only hides its unread dot locally.
  const [readIds, setReadIds] = useState<number[]>([]);
  // Browser/device Back closes open drawers/overlays first (no navigation).
  useOverlayBackClose(mobileOpen, () => setMobileOpen(false));
  useOverlayBackClose(mobileSearchOpen, () => setMobileSearchOpen(false));

  useEffect(() => {
    // localStorage is only available after mount (SSR-safe restore)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(
      window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed"
    );
    setReadIds(loadReadIds());
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    const onClick = (event: MouseEvent) => {
      if (
        profileRef.current &&
        !profileRef.current.contains(event.target as Node)
      ) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [profileOpen]);

  useEffect(() => {
    if (!notifOpen) return;
    const onClick = (event: MouseEvent) => {
      if (
        notifRef.current &&
        !notifRef.current.contains(event.target as Node)
      ) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [notifOpen]);
  useOverlayBackClose(notifOpen, () => setNotifOpen(false));

  // Keep the feed fresh while the admin panel is open
  // (initial load + 30s polling + window focus + every bell open).
  // Returns the fresh payload so open-handlers can act on it (auto-read).
  const loadRecent = useCallback(async () => {
    if (!gate.ready) return null;
    try {
      const response = await fetch("/api/admin/activity/recent", {
        cache: "no-store",
        headers: gate.headers,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        logs?: RecentActivity[];
        pending?: PendingItem[];
      };
      if (Array.isArray(data.logs)) setNotifItems(data.logs);
      if (Array.isArray(data.pending)) setPendingItems(data.pending);
      return data;
    } catch {
      // Bell stays quiet on failure — never blocks the panel.
      return null;
    }
  }, [gate.ready, gate.headers]);

  useEffect(() => {
    if (!gate.ready) return;
    void loadRecent();
    const timer = window.setInterval(() => void loadRecent(), 30_000);
    const onFocus = () => void loadRecent();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [gate.ready, loadRecent]);

  // Badge = pending work + unread activity. Pending clears on
  // approve/reject; activity clears when the bell is opened or via
  // mark-as-read below.
  const pendingCount = pendingItems.length;
  const unreadActivity = useMemo(
    () => notifItems.filter((item) => !readIds.includes(Number(item.id))),
    [notifItems, readIds],
  );
  const badgeCount = pendingCount + unreadActivity.length;

  const persistReadIds = (ids: number[]) => {
    const clean = ids
      .map((v) => Number(v))
      .filter((n): n is number => Number.isFinite(n));
    setReadIds(clean);
    try {
      window.localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(clean.slice(-200)));
    } catch {}
  };

  const markOneRead = (id: number) => {
    const n = Number(id);
    if (!Number.isFinite(n) || readIds.includes(n)) return;
    persistReadIds([...readIds, n]);
  };

  const markAllRead = (items: RecentActivity[] = notifItems) => {
    persistReadIds([
      ...readIds,
      ...items.map((item) => Number(item.id)).filter((n) => Number.isFinite(n)),
    ]);
  };

  const toggleNotif = () => {
    setNotifOpen((open) => {
      if (!open) {
        // Opening the bell marks currently-visible activity as seen, so the
        // badge actually drops. Pending work stays until approved/rejected.
        void loadRecent().then((data) => {
          const logs = Array.isArray(data?.logs) ? data.logs : notifItems;
          markAllRead(logs);
        });
      }
      return !open;
    });
  };

  // Close the mobile drawer ONLY after a menu item's route has actually
  // changed. Removing the premature onClick handler from the items means
  // clicks/taps are no longer intercepted — navigation fires first, and
  // the drawer slides away once the new page mounts.
  const lastPathRef = useRef(pathname);
  useEffect(() => {
    if (mobileOpen && pathname !== lastPathRef.current) {
      lastPathRef.current = pathname;
      setMobileOpen(false);
    }
  }, [mobileOpen, pathname]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          SIDEBAR_STORAGE_KEY,
          next ? "collapsed" : "expanded"
        );
      } catch {}
      return next;
    });
  };

  const handleLogout = async () => {
    closeOverlays();
    try {
      if (user) {
        const token = await user.getIdToken();
        await fetch("/api/admin/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Logging the logout is best-effort — always sign out.
    }
    await signOut();
    router.replace("/");
  };

  const closeOverlays = () => {
    setMobileOpen(false);
    setProfileOpen(false);
    setNotifOpen(false);
  };

  const active = findActiveAdminNav(pathname);

  // Filtered nav for RBAC — respects role permissions, keeps routes unchanged.
  // Memoized: ADMIN_NAV is static, so this only recomputes when the role changes.
  const visibleNav = useMemo(
    () =>
      ADMIN_NAV.filter((item) =>
        hasControlAccess(gate.role, gate.permissions, item.href),
      ),
    [gate.role, gate.permissions],
  );
  const homeItem = visibleNav.find((i) => i.href === "/admin") ?? ADMIN_NAV[0];
  const managementItems = useMemo(
    () => visibleNav.filter((i) => i.href !== "/admin"),
    [visibleNav],
  );

  // Route-level RBAC with parent → subtree inheritance (Public Exam Control
  // → Category → Exam → Exam Management resolve to the parent control via
  // segment-aware longest-prefix match). Only enforced once the gate resolves;
  // while loading, pages render normally and show their own loaders. Unknown
  // routes fail closed (denied); Admin bypasses every check.
  const isDeniedByRole =
    gate.ready && !hasControlAccess(gate.role, gate.permissions, pathname);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/");

  // Header title/breadcrumb prefers ADMIN_NAV match for new routes.
  // ADMIN_NAV sorted once (module-level order) instead of on every render.
  const activeNavItem = useMemo(
    () =>
      [...ADMIN_NAV]
        .sort((a, b) => b.href.length - a.href.length)
        .find((item) => pathname === item.href || pathname.startsWith(item.href + "/")),
    [pathname],
  );
  const displayTitle = activeNavItem ? activeNavItem.label : active.title;
  const displayBreadcrumbs =
    activeNavItem && activeNavItem.href !== "/admin"
      ? [
          { label: "HOME", href: "/admin" },
          { label: activeNavItem.label, href: activeNavItem.href },
        ]
      : active.breadcrumbs;

  const sidebarContent = (
    <>
      <Link
        href="/admin"
        className={`flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-5 ${
          collapsed ? "justify-center px-0" : ""
        }`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-600 text-white shadow-lg shadow-primary-900/40">
          <WebsiteIcon className="h-5 w-5" />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-extrabold tracking-tight text-white">
              MediSpark Admin
            </span>
            <span className="block text-[11px] font-semibold uppercase tracking-widest text-primary-500">
              Control Center
            </span>
          </span>
        )}
      </Link>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {/* HOME — completely separate and appears first */}
        <Link
        href={homeItem.href}
        title={collapsed ? homeItem.label : undefined}
        aria-current={isActive(homeItem.href) ? "page" : undefined}
          className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-200 ${
            collapsed ? "justify-center" : ""
          } ${
            isActive(homeItem.href)
              ? "bg-primary-600 text-white shadow-md shadow-primary-900/40"
              : "text-zinc-400 hover:bg-white/5 hover:text-white"
          }`}
        >
          <homeItem.icon className="h-5 w-5 shrink-0" />
          {!collapsed && <span>{homeItem.label}</span>}
        </Link>

        {/* MANAGEMENT — visual heading only, not clickable */}
        <p
          className={`px-3 pb-1 pt-5 text-[11px] font-bold uppercase tracking-widest text-zinc-600 ${
            collapsed ? "text-center" : ""
          }`}
        >
          {collapsed ? "•••" : "MANAGEMENT"}
        </p>

        <ul className="space-y-1">
          {managementItems.map((item) => {
            const activeItem = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={activeItem ? "page" : undefined}
                  className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition duration-200 ${
                    collapsed ? "justify-center" : ""
                  } ${
                    activeItem
                      ? "bg-primary-600 text-white shadow-md shadow-primary-900/40"
                      : "text-zinc-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-white/10 p-3">
        <button
          type="button"
          data-no-global-loader
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleCollapsed();
          }}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <PanelLeftIcon className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </>
  );

  return (
    <AdminToastProvider>
      <div
        data-admin-theme={theme}
        className="flex min-h-screen bg-neutral-100 transition-colors duration-300 admin-dark:bg-zinc-950"
      >
      {/* Desktop sidebar */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col bg-zinc-950 lg:flex ${
          collapsed ? "w-[76px]" : "w-64"
        } transition-[width] duration-300`}
      >
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            data-no-global-loader
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMobileOpen(false);
            }}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <aside className="absolute left-0 top-0 z-10 flex h-full w-72 max-w-[85vw] flex-col bg-zinc-950 shadow-2xl shadow-black/60">
            <button
              type="button"
              aria-label="Close menu"
              data-no-global-loader
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMobileOpen(false);
              }}
              className="absolute right-3 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top header */}
        <header className={`sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-4 transition-colors duration-200 sm:px-6 admin-dark:border-zinc-800 admin-dark:bg-zinc-900 ${scrolled ? "lg:shadow-lg lg:shadow-black/25" : ""}`}>
          <button
            type="button"
            aria-label="Open menu"
            data-no-global-loader
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMobileOpen(true);
            }}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 text-zinc-700 transition hover:border-primary-500/60 hover:bg-neutral-50 lg:hidden admin-dark:border-zinc-700 admin-dark:text-zinc-200 admin-dark:hover:bg-zinc-800"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            {displayBreadcrumbs.length > 1 && (
              <nav aria-label="Breadcrumb" className="hidden sm:block">
                <ol className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-500 admin-dark:text-zinc-400">
                  {displayBreadcrumbs.slice(0, -1).map((crumb, index) => (
                    <li key={crumb.href + index} className="flex items-center gap-1.5">
                      <Link
                        href={crumb.href}
                        className="transition hover:text-[#1a3a78] admin-dark:hover:text-primary-400"
                      >
                        {crumb.label}
                      </Link>
                      <span className="text-zinc-400 admin-dark:text-zinc-600">/</span>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <h1 className="truncate text-base font-bold text-zinc-900 transition-colors duration-300 sm:text-lg admin-dark:text-zinc-50">
              {displayTitle}
            </h1>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* Search — desktop dropdown */}
            <div className="hidden w-40 md:block lg:w-52 xl:w-64">
              <AdminSearch />
            </div>
            {/* Search toggle — mobile */}
            <button
              type="button"
              aria-label="Search sections"
              onClick={() => setMobileSearchOpen((open) => !open)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 text-zinc-700 transition hover:border-primary-500/60 hover:bg-neutral-50 md:hidden admin-dark:border-zinc-700 admin-dark:text-zinc-200 admin-dark:hover:bg-zinc-800"
            >
              <SearchIcon className="h-5 w-5" />
            </button>

            {/* Theme toggle — Admin Panel only */}
            <AdminThemeToggle />

            {/* Notifications */}
            <div ref={notifRef} className="relative">
              <button
                type="button"
                onClick={toggleNotif}
                aria-label="Notifications"
                aria-expanded={notifOpen}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 text-zinc-700 transition hover:border-primary-500/60 hover:bg-neutral-50 admin-dark:border-zinc-700 admin-dark:text-zinc-200 admin-dark:hover:bg-zinc-800"
              >
                <NotificationsIcon className="h-5 w-5" />
                {badgeCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-600 px-1 text-[10px] font-bold text-white">
                    {badgeCount > 9 ? "9+" : badgeCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-black/10 admin-dark:border-zinc-700 admin-dark:bg-zinc-900">
                  <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3 admin-dark:border-zinc-800">
                    <p className="text-sm font-bold text-zinc-900 admin-dark:text-zinc-50">
                      Notifications
                    </p>
                    <div className="flex items-center gap-2">
                      {pendingCount > 0 && (
                        <span className="rounded-full bg-primary-600/10 px-2 py-0.5 text-[10px] font-bold text-primary-700 admin-dark:text-primary-400">
                          {pendingCount} pending
                        </span>
                      )}
                      {unreadActivity.length > 0 && (
                        <button
                          type="button"
                          onClick={() => markAllRead()}
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold text-primary-700 transition hover:bg-primary-600/10 admin-dark:text-primary-400"
                        >
                          Mark all read
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {/* Pending work first — enrollment requests waiting for approval. */}
                    {pendingCount > 0 && (
                      <ul className="divide-y divide-neutral-100 admin-dark:divide-zinc-800">
                        {pendingItems.map((item) => (
                          <li key={`pending-${item.id}`}>
                            <Link
                              href={`/admin/enrollment-control/course/${encodeURIComponent(item.courseId)}`}
                              onClick={closeOverlays}
                              className="block px-4 py-3 transition hover:bg-primary-600/5"
                            >
                              <p className="flex items-center gap-2 text-xs font-bold text-zinc-900 admin-dark:text-zinc-50">
                                <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                                <span className="truncate">
                                  {item.courseKind === "paid" ? "New enrollment request" : "New free enrollment"} — {item.studentName}
                                </span>
                              </p>
                              <p className="mt-0.5 truncate pl-4 text-xs text-zinc-600 admin-dark:text-zinc-300">
                                {item.courseName}
                                {item.courseKind === "paid" && item.fee > 0 ? ` · ৳${item.fee}` : ""}
                              </p>
                              <p className="mt-1 pl-4 text-[10px] font-semibold text-primary-700 admin-dark:text-primary-400">
                                Tap to review → {timeAgoMs(item.createdAt)}
                              </p>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    {pendingCount === 0 && (
                      <p className="border-b border-neutral-100 px-4 py-4 text-center text-xs font-semibold text-zinc-500 admin-dark:border-zinc-800">
                        🎉 All caught up — no pending requests.
                      </p>
                    )}
                    {/* Recent admin activity below (full log stays in audit). */}
                    <p className="px-4 pb-1 pt-3 text-[10px] font-bold uppercase tracking-wide text-zinc-400">
                      Recent activity
                    </p>
                    <ul className="divide-y divide-neutral-100 admin-dark:divide-zinc-800">
                      {notifItems.length === 0 ? (
                        <li className="px-4 py-4 text-center text-xs text-zinc-500">
                          No activity yet.
                        </li>
                      ) : (
                        notifItems.map((item) => {
                          const isUnread = !readIds.includes(item.id);
                          return (
                            <li key={item.id}>
                              <Link
                                href={activityHref(item.action)}
                                onClick={() => {
                                  markOneRead(item.id);
                                  closeOverlays();
                                }}
                                className="block px-4 py-2.5 transition hover:bg-primary-600/5"
                              >
                                <p className="flex items-center gap-2 text-xs font-bold capitalize text-zinc-900 admin-dark:text-zinc-50">
                                  {isUnread && (
                                    <span className="h-2 w-2 shrink-0 rounded-full bg-primary-600" />
                                  )}
                                  {formatActivityAction(item.action)}
                                </p>
                                {item.detail && (
                                  <p className="mt-0.5 line-clamp-2 pl-4 text-xs text-zinc-600 admin-dark:text-zinc-300">
                                    {item.detail}
                                  </p>
                                )}
                                <p className="mt-0.5 pl-4 text-[10px] text-zinc-400">
                                  {item.adminEmail || "Admin"} · {timeAgo(item.createdAt)}
                                </p>
                              </Link>
                            </li>
                          );
                        })
                      )}
                    </ul>
                  </div>
                  <Link
                    href="/admin/administration/activity-logs"
                    onClick={closeOverlays}
                    className="block border-t border-neutral-100 px-4 py-2.5 text-center text-xs font-bold text-primary-700 transition hover:bg-primary-600/5 admin-dark:border-zinc-800 admin-dark:text-primary-400"
                  >
                    View all activity
                  </Link>
                </div>
              )}
            </div>

            {/* Profile */}
            <div ref={profileRef} className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((open) => !open)}
                className="flex items-center gap-2.5 rounded-xl border border-neutral-200 py-1.5 pl-1.5 pr-2.5 transition hover:border-primary-500/60 hover:bg-neutral-50 sm:pr-3 admin-dark:border-zinc-700 admin-dark:hover:bg-zinc-800"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600 text-xs font-bold text-white">
                  A
                </span>
                <span className="hidden text-left sm:block">
                  <span className="block text-xs font-bold leading-tight text-zinc-900 admin-dark:text-zinc-50">
                    Admin
                  </span>
                  <span className="block text-[10px] leading-tight text-zinc-500">
                    Administrator
                  </span>
                </span>
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-black/10 admin-dark:border-zinc-700 admin-dark:bg-zinc-900">
                  <div className="border-b border-neutral-100 px-4 py-3 admin-dark:border-zinc-800">
                    <p className="text-sm font-bold text-zinc-900 admin-dark:text-zinc-50">
                      Admin
                    </p>
                    <p className="text-xs text-zinc-500">admin@medispark.com</p>
                  </div>
                  <Link
                    href="/admin/administration/admins"
                    onClick={closeOverlays}
                    className="flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-neutral-50 admin-dark:text-zinc-200 admin-dark:hover:bg-zinc-800"
                  >
                    <SettingsIcon className="h-4 w-4 text-zinc-400" />
                    Profile Settings
                  </Link>
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    className="flex w-full items-center gap-2.5 border-t border-neutral-100 px-4 py-2.5 text-sm font-medium text-primary-700 transition hover:bg-primary-600/5 admin-dark:border-zinc-800 admin-dark:text-primary-400"
                  >
                    <LogoutIcon className="h-4 w-4" />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Mobile search panel */}
        {mobileSearchOpen && (
          <div className="sticky top-16 z-30 border-b border-neutral-200 bg-white px-4 py-3 transition-colors duration-300 md:hidden admin-dark:border-zinc-800 admin-dark:bg-zinc-900">
            <AdminSearch
              autoFocus
              onNavigate={() => setMobileSearchOpen(false)}
            />
          </div>
        )}

        <main className="flex-1">
          {isDeniedByRole ? (
            <div className="mx-auto max-w-lg px-4 py-16 text-center sm:px-6">
              <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-8">
                <p className="text-lg font-extrabold text-yellow-700 admin-dark:text-yellow-300">
                  Access denied for your role
                </p>
                <p className="mt-2 text-sm leading-relaxed text-neutral-600 admin-dark:text-slate-400">
                  Your current role (<span className="font-bold capitalize">{gate.role ?? "unknown"}</span>) does
                  not have permission to access{" "}
                  <span className="font-mono text-xs font-bold">{pathname}</span>. Contact an Admin to grant
                  access.
                </p>
                <Link
                  href="/admin"
                  className="mt-6 inline-block rounded-xl bg-primary-600 px-6 py-3 text-sm font-bold text-white shadow-md hover:bg-primary-700"
                >
                  Back to Admin Home
                </Link>
              </div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      </div>
    </AdminToastProvider>
  );
}
