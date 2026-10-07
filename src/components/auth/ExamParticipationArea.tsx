"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AccessLoading, AccessMessage } from "@/components/auth/AccessGuard";
import MediSparkLoader from "@/components/MediSparkLoader";
import { useExamLock } from "@/components/exam/ExamLockContext";
import {
  ExamRulesList,
  type ExamRulesData,
} from "@/components/ExamRules";
import { answerIndexToLetter } from "@/lib/paste-mcq-parser";
import { examResultApiPath } from "@/lib/exam-result-language";

type TakingExam = ExamRulesData & {
  id: string;
  subject: string;
  /** True when the live window has ended — attempts are unranked practice; retakes allowed. */
  isPostLivePractice?: boolean;
};

type TakingQuestion = {
  id: number;
  question: string;
  options: string[];
  marks: number;
  questionImage?: string | null;
};

type SubmissionOutcome = {
  score: number;
  totalMarks: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  rawMarks?: number;
  negativeMarks?: number;
  negativeDeduction?: number;
  timerPenalty?: number;
  secondTimer?: boolean;
  autoSubmitted?: boolean;
  meritPosition?: number | null;
  timeTakenSeconds?: number | null;
  highestMark?: number | null;
  examName?: string;
  questionVersion?: "bangla" | "english" | null;
};

type ScriptQuestion = {
  questionId: number;
  question: string;
  options: string[];
  marks: number;
  chosenIndex: number | null;
  /** NULL = unknown answer — rendered as "—", never defaulted to A. */
  correctIndex: number | null;
  obtained: number;
  explanation?: string | null;
  questionImage?: string | null;
  contentFallback?: "base" | "unavailable" | null;
};

type ResultScript = {
  examName: string;
  score: number;
  totalMarks: number;
  timeTakenSeconds: number | null;
  meritPosition: number | null;
  questionVersion?: "bangla" | "english" | null;
  questions: ScriptQuestion[];
};

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Actual time taken, e.g. "27 min 35 sec" / "32 min" / "45 sec". */
function formatTimeTaken(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m} min`;
  if (m > 0 && s > 0) return `${m} min ${s} sec`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
}

function padNum(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Clean loading screen shown after Rules → Continue while the question paper
 * is being prepared. No metadata, no counts, no partial paper — just this.
 * Uses unified MediSparkLoader for consistent branding.
 */
function PreparingExamScreen() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center px-4 py-16"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-2xl border border-ink/10 bg-dark-900 p-8 text-center shadow-lg shadow-black/20 sm:p-10">
        <MediSparkLoader size="medium" label="Preparing your exam question..." withBranding={false} />
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          আপনার পরীক্ষার প্রশ্ন প্রস্তুত করা হচ্ছে। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।
        </p>
      </div>
    </div>
  );
}

export default function ExamParticipationArea({
  examId,
  autoBegin: propAutoBegin,
  timerType: propTimerType,
}: {
  examId: string;
  /** True when the student already accepted the Exam Rules (Start Now flow). */
  autoBegin?: boolean;
  /** First or second timer — affects grading penalty. */
  timerType?: "first" | "second";
}) {
  const searchParams = useSearchParams();
  const autoBegin = propAutoBegin ?? searchParams.get("begin") === "1";
  const timerType = propTimerType ?? (searchParams.get("timer") === "second" ? "second" : "first");
  const versionParamRaw = searchParams.get("version");
  const versionFromUrl: "bangla" | "english" | null =
    versionParamRaw === "english" ? "english" : versionParamRaw === "bangla" ? "bangla" : null;
  const examHref = `/exam/${examId}`;
  const loginHref = `/login?next=${encodeURIComponent(examHref)}`;
  const { user, profile, authLoading, profileLoading } = useAuth();
  const {
    setLocked: setExamLocked,
  } = useExamLock();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exam, setExam] = useState<TakingExam | null>(null);
  const [questions, setQuestions] = useState<TakingQuestion[]>([]);
  // Active question rows in the DB (pre-strip). Stays > 0 even when the
  // preview gate strips question content — so a stripped preview never
  // looks like a question-less exam. Null = not loaded yet.
  const [totalQuestionCount, setTotalQuestionCount] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Submit failure is shown inline (exam stays open for retry) — it must
  // never replace the exam UI or reset timer/answers/attempt.
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [terminatedNotice, setTerminatedNotice] = useState(false);
  // Strict one-attempt: if already completed, show View Result instead of Start Exam
  const [alreadyAttempted, setAlreadyAttempted] = useState(false);
  // Rules accepted → the actual attempt has begun.
  const [begun, setBegun] = useState(false);
  // Question Version — preselected from the Rules page (?version=); the
  // in-exam rules gate below also requires an explicit choice. Locked
  // server-side at start; never switchable during the active exam.
  const [questionVersion, setQuestionVersion] = useState<"bangla" | "english" | null>(versionFromUrl);
  const [beginning, setBeginning] = useState(false);
  // Admin-managed DB rules for this exam (same source as the /rules page).
  // Loaded fresh (no-store) so updates appear immediately; falls back to the
  // static ExamRulesList when unavailable.
  const [dbRules, setDbRules] = useState<Array<{ id: number | null; title: string; text: string }> | null>(null);
  const [dbRulesEn, setDbRulesEn] = useState<Array<{ id: number | null; title: string; text: string }> | null>(null);
  const [script, setScript] = useState<ResultScript | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  // Connectivity (non-blocking): offline NEVER submits; answers queue as pending_sync.
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [reconnecting, setReconnecting] = useState(false);
  const submittedRef = useRef(false);
  const answersRef = useRef<Record<number, number>>({});
  const tokenRef = useRef<string | null>(null);
  // Fixed server-side expiration (ms, server clock) + device-clock offset.
  // Countdown display derives from expiresAt - (now + offset); refresh safe.
  const expiresAtRef = useRef<number | null>(null);
  const serverOffsetRef = useRef(0);
  const begunRef = useRef(false);
  const pendingKey = `exam-pending-${user?.uid ?? "anonymous"}-${examId}`;

  /** Apply authoritative timing from the backend (expires_at + server_now). */
  const applyServerTiming = useCallback(
    (expiresAtIso?: string | null, serverNowIso?: string | null, fallbackSeconds?: number | null, durationMinutes?: number) => {
      const now = Date.now();
      if (expiresAtIso) {
        const expMs = new Date(expiresAtIso).getTime();
        if (!Number.isNaN(expMs)) {
          expiresAtRef.current = expMs;
          const srvMs = serverNowIso ? new Date(serverNowIso).getTime() : NaN;
          serverOffsetRef.current = Number.isNaN(srvMs) ? 0 : srvMs - now;
          const remaining = Math.max(0, Math.round((expMs - (Date.now() + serverOffsetRef.current)) / 1000));
          setSecondsLeft(remaining);
          return;
        }
      }
      if (typeof fallbackSeconds === "number" && Number.isFinite(fallbackSeconds)) {
        const rem = Math.max(0, Math.floor(fallbackSeconds));
        // No absolute expiry — anchor a display-only expiry that the server
        // still overrules on submit/heartbeat (never authoritative).
        expiresAtRef.current = now + serverOffsetRef.current + rem * 1000;
        setSecondsLeft(rem);
        return;
      }
      if (durationMinutes) {
        const rem = Math.max(60, durationMinutes * 60);
        expiresAtRef.current = now + serverOffsetRef.current + rem * 1000;
        setSecondsLeft(rem);
      }
    },
    [],
  );

  /** Load locally queued offline answers (pending_sync). */
  const loadPending = useCallback((): Record<string, number> => {
    try {
      const raw = window.localStorage.getItem(`${pendingKey}:${tokenRef.current}`);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, number>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }, [pendingKey]);

  const savePending = useCallback(
    (pending: Record<string, number>) => {
      try {
        if (Object.keys(pending).length === 0) window.localStorage.removeItem(`${pendingKey}:${tokenRef.current}`);
        else window.localStorage.setItem(`${pendingKey}:${tokenRef.current}`, JSON.stringify(pending));
      } catch {}
    },
    [pendingKey],
  );

  const submit = useCallback(async (isAuto = false) => {
    // Duplicate guard: one submission per attempt — concurrent triggers
    // (button, timer expiry, heartbeat expiry) collapse into a single POST.
    // The backend atomically decides manual vs auto via expires_at.
    if (submittedRef.current || !user) return;
    submittedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const token = await user.getIdToken();
      const response = await fetch(
        `/api/exams/${encodeURIComponent(examId)}/submit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            token: tokenRef.current,
            answers: Object.fromEntries(
              Object.entries(answersRef.current).map(([key, value]) => [
                key,
                value,
              ]),
            ),
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as
        | SubmissionOutcome
        | { error?: string };
      if ("score" in data) {
        // Backend is authoritative: it flags autoSubmitted when now >= expires_at.
        try {
          window.localStorage.removeItem(`${pendingKey}:${tokenRef.current}`);
        } catch {}
        setOutcome(isAuto ? { ...data, autoSubmitted: true } : data);
      } else {
        // Allow retry on failure — the exam stays exactly as it was.
        submittedRef.current = false;
        setSubmitError("error" in data && data.error ? data.error : "Submission failed. Please try again.");
      }
    } catch {
      submittedRef.current = false;
      setSubmitError("Submission failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }, [examId, user, pendingKey]);

  /**
   * Push queued offline answers (pending_sync) to the server. Runs on
   * reconnect/resume. Stale-safe: skips questions the server already holds.
   */
  const syncPending = useCallback(
    async (sessionToken?: string | null) => {
      const token = sessionToken ?? tokenRef.current;
      if (!token || !user || submittedRef.current) return;
      let pending: Record<string, number> = {};
      try {
        const raw = window.localStorage.getItem(`${pendingKey}:${token}`);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (!parsed || typeof parsed !== "object") return;
        pending = parsed;
      } catch {
        return;
      }
      const keys = Object.keys(pending);
      if (keys.length === 0) return;
      setReconnecting(true);
      try {
        const authToken = await user.getIdToken();
        const remaining: Record<string, number> = {};
        for (const [qid, opt] of Object.entries(pending)) {
          // Skip what the server already stored (answersRef = server state).
          if (answersRef.current[Number(qid)] !== undefined && answersRef.current[Number(qid)] === opt) continue;
          try {
            const res = await fetch(`/api/exams/${encodeURIComponent(examId)}/answer`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify({ token, questionId: Number(qid), optionIndex: opt }),
            });
            if (!res.ok && res.status !== 409) remaining[qid] = opt;
            // 409 = server already holds an answer (locked) — drop from queue.
          } catch {
            remaining[qid] = opt;
          }
        }
        savePending(remaining);
        // Merge whatever synced into live state so counts stay correct.
        if (Object.keys(remaining).length !== keys.length) {
          const merged = { ...answersRef.current };
          for (const [qid, opt] of Object.entries(pending)) {
            if (remaining[qid] === undefined) merged[Number(qid)] = opt;
          }
          answersRef.current = merged;
          setAnswers(merged);
        }
      } finally {
        setReconnecting(false);
      }
    },
    [examId, user, pendingKey, savePending],
  );
  // Exam Fixed Header — measured offset so it stays directly below the normal website header
  const [headerOffset, setHeaderOffset] = useState(64);

  /**
   * Activate a server session — resume or fresh start share this path.
   * Restores previously saved answers; the countdown anchors to the fixed
   * server-side expires_at (never reset on refresh).
   */
  const activateSession = useCallback(
    (
      sessionToken: string | null,
      durationMinutes: number,
      serverSecondsLeft?: number | null,
      opts?: {
        expiresAt?: string | null;
        serverNow?: string | null;
        storedAnswers?: Record<string, number> | null;
      },
    ) => {
      tokenRef.current = sessionToken;
      const restored: Record<number, number> = {};
      if (opts?.storedAnswers && typeof opts.storedAnswers === "object") {
        for (const [k, v] of Object.entries(opts.storedAnswers)) {
          const qid = Number(k);
          if (Number.isInteger(qid) && Number.isInteger(v as number)) restored[qid] = v as number;
        }
      }
      // Merge only this student's current attempt; old retake queues are isolated.
      try {
        const raw = window.localStorage.getItem(`${pendingKey}:${sessionToken}`);
        if (raw) {
          const pending = JSON.parse(raw) as Record<string, number>;
          if (pending && typeof pending === "object") {
            for (const [k, v] of Object.entries(pending)) {
              const qid = Number(k);
              if (Number.isInteger(qid) && restored[qid] === undefined && Number.isInteger(v)) {
                restored[qid] = v;
              }
            }
          }
        }
      } catch {}
      answersRef.current = restored;
      setAnswers(restored);
      setBegun(true);
      begunRef.current = true;
      applyServerTiming(opts?.expiresAt ?? null, opts?.serverNow ?? null, serverSecondsLeft ?? null, durationMinutes);
    },
    [applyServerTiming, pendingKey],
  );

  /**
   * Begin the real attempt — creates the server session and starts the
   * timer. Only called after the student accepts the exam rules.
   */
  const beginExam = useCallback(async () => {
    if (!user || beginning || begun || !exam) return;
    // Version defaults to the Rules-page choice, then the in-exam gate
    // choice, then Bangla (legacy links without ?version=).
    const version = questionVersion ?? versionFromUrl ?? "bangla";
    setBeginning(true);
    try {
      const authToken = await user.getIdToken();
      const response = await fetch(
        `/api/exams/${encodeURIComponent(examId)}?start=1&timer=${timerType}&version=${version}`,
        {
          headers: authToken
            ? { Authorization: `Bearer ${authToken}` }
            : undefined,
          cache: "no-store",
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        sessionToken?: string | null;
        secondsLeft?: number | null;
        questions?: TakingQuestion[];
        questionVersion?: "bangla" | "english" | null;
        abandonedOutcome?: SubmissionOutcome | null;
        expiresAt?: string | null;
        serverNow?: string | null;
        storedAnswers?: Record<string, number> | null;
        totalQuestionCount?: number | null;
        error?: string;
      };
      if (!response.ok) {
        setLoadError(data.error ?? "Could not start the exam. Please retry.");
        return;
      }
      if (data.abandonedOutcome && "score" in data.abandonedOutcome) {
        submittedRef.current = true;
        setOutcome({ ...data.abandonedOutcome, autoSubmitted: true });
        setAlreadyAttempted(true);
        return;
      }
      // Locked server order — replace the preview list with the student's
      // assigned Version/Set questions in randomized display order.
      if (Array.isArray(data.questions) && data.questions.length > 0) {
        setQuestions(data.questions);
      }
      if (typeof data.totalQuestionCount === "number") {
        setTotalQuestionCount(data.totalQuestionCount);
      }
      if (data.questionVersion === "bangla" || data.questionVersion === "english") {
        setQuestionVersion(data.questionVersion);
      } else {
        setQuestionVersion(version);
      }
      // Resume path: ?start=1 returns the EXISTING attempt (same expires_at)
      // with stored answers — never a fresh timer.
      activateSession(data.sessionToken ?? null, exam.durationMinutes, data.secondsLeft ?? null, {
        expiresAt: data.expiresAt ?? null,
        serverNow: data.serverNow ?? null,
        storedAnswers: data.storedAnswers ?? null,
      });
    } catch {
      setLoadError("Failed to start the exam. Check your connection.");
    } finally {
      setBeginning(false);
    }
  }, [beginning, begun, exam, examId, user, activateSession, timerType, questionVersion, versionFromUrl, submit]);

  // DB exam rules — fresh on every mount (no-store) so admin updates show
  // immediately instead of stale built-in rules.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/exams/${encodeURIComponent(examId)}/rules`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => null)) as {
          rules?: Array<{ id: number | null; title: string; text: string }>;
          rulesEn?: Array<{ id: number | null; title: string; text: string }>;
        } | null;
        if (!cancelled && res.ok && data) {
          if (Array.isArray(data.rules) && data.rules.length > 0) setDbRules(data.rules);
          if (Array.isArray(data.rulesEn) && data.rulesEn.length > 0) setDbRulesEn(data.rulesEn);
        }
      } catch {
        // ignore — static ExamRulesList remains as fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [examId]);

  // Load exam meta. Resume model: a plain GET (no ?start=1) returns the
  // EXISTING active attempt (same expires_at + stored answers) when one is
  // live — refresh/reopen reconnects to it instead of restarting.
  useEffect(() => {
    if (authLoading || profileLoading || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await user.getIdToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        // Exam meta + prior-attempt are independent — fetch together so the
        // page waits for one round trip instead of two.
        const [response, priorRes] = await Promise.all([
          fetch(`/api/exams/${encodeURIComponent(examId)}`, {
            headers,
            cache: "no-store",
          }),
          fetch(`/api/exams/${encodeURIComponent(examId)}/prior-attempt`, {
            headers,
            cache: "no-store",
          }),
        ]);
        const data = (await response.json().catch(() => ({}))) as {
          exam?: TakingExam;
          questions?: TakingQuestion[];
          sessionToken?: string | null;
          secondsLeft?: number | null;
          expiresAt?: string | null;
          serverNow?: string | null;
          attemptStatus?: string | null;
          storedAnswers?: Record<string, number> | null;
          questionVersion?: "bangla" | "english" | null;
          abandonedOutcome?: SubmissionOutcome | null;
          totalQuestionCount?: number | null;
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok || !data.exam) {
          setLoadError(data.error ?? "This exam is not available right now.");
          return;
        }
        // Re-entering after expiry — the backend lazy-auto-submitted it;
        // show its result instead of reopening.
        if (data.abandonedOutcome && "score" in data.abandonedOutcome) {
          if (!cancelled) {
            submittedRef.current = true;
            setExam(data.exam);
            setOutcome({ ...data.abandonedOutcome, autoSubmitted: true });
            setAlreadyAttempted(true);
          }
          return;
        }
        setExam(data.exam);
        setQuestions(data.questions ?? []);
        if (typeof data.totalQuestionCount === "number") {
          setTotalQuestionCount(data.totalQuestionCount);
        }
        // Resume: an active attempt already exists (refresh / reopened tab /
        // reconnected). Restore it directly — same expires_at, same answers.
        // Skipped when autoBegin will start-or-resume below (it hydrates too).
        if (
          !autoBegin &&
          data.sessionToken &&
          data.attemptStatus === "active" &&
          (data.secondsLeft ?? 0) >= 0 &&
          (data.questions?.length ?? 0) > 0
        ) {
          if (data.questionVersion === "bangla" || data.questionVersion === "english") {
            setQuestionVersion(data.questionVersion);
          }
          activateSession(data.sessionToken, data.exam.durationMinutes, data.secondsLeft ?? null, {
            expiresAt: data.expiresAt ?? null,
            serverNow: data.serverNow ?? null,
            storedAnswers: data.storedAnswers ?? null,
          });
          // Sync any offline pending_sync answers now that we're back.
          void syncPending(data.sessionToken);
          if (!cancelled) setLoading(false);
          return;
        }
        // Strict one-attempt: check if already has completed attempt for this public exam.
        // Post-live Practice phase is exempt — past the End Time every attempt
        // is an unranked practice attempt, so prior live attempts never block
        // starting practice. Same for enrolled-archived and static-practice
        // exams (server allows unlimited practice retakes for both).
        try {
          const priorData = (await priorRes.json().catch(() => ({}))) as { hasPriorAttempt?: boolean; canPracticeRetake?: boolean };
          if (!cancelled && priorRes.ok && priorData.hasPriorAttempt && !data.exam.isPostLivePractice && !priorData.canPracticeRetake) {
            // Already appeared — fetch existing result and show View Result instead of Start Exam
            setAlreadyAttempted(true);
            try {
              const resultRes = await fetch(`/api/exams/${encodeURIComponent(examId)}/result`, {
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                cache: "no-store",
              });
              const resultData = (await resultRes.json().catch(() => ({}))) as SubmissionOutcome & { error?: string };
              if (!cancelled && resultRes.ok && "score" in resultData) {
                setOutcome(resultData as SubmissionOutcome);
              } else {
                // Fallback: show already attempted notice even if result fetch fails
                setOutcome({
                  score: 0,
                  totalMarks: data.exam.totalMarks ?? 0,
                  correctCount: 0,
                  wrongCount: 0,
                  skippedCount: 0,
                  examName: data.exam.name,
                } as SubmissionOutcome);
              }
            } catch {
              // ignore
            }
            return;
          }
        } catch {
          // ignore prior check failure — proceed to normal flow
        }
        // "Start Now" flow: rules were already accepted on the exam card,
        // so begin the attempt right away without showing them again.
        // totalQuestionCount covers stripped previews — start fetches the
        // real locked questions, so don't require preview content here.
        if (autoBegin && ((data.questions?.length ?? 0) > 0 || (data.totalQuestionCount ?? 0) > 0)) {
          try {
            const authToken = await user.getIdToken();
            const startVersion = versionFromUrl ?? "bangla";
            const startResponse = await fetch(
              `/api/exams/${encodeURIComponent(examId)}?start=1&timer=${timerType}&version=${startVersion}`,
              {
                headers: authToken
                  ? { Authorization: `Bearer ${authToken}` }
                  : undefined,
                cache: "no-store",
              },
            );
            const startData = (await startResponse
              .json()
              .catch(() => ({}))) as { sessionToken?: string | null; secondsLeft?: number | null; questions?: TakingQuestion[]; questionVersion?: "bangla" | "english" | null; expiresAt?: string | null; serverNow?: string | null; storedAnswers?: Record<string, number> | null; abandonedOutcome?: SubmissionOutcome | null; totalQuestionCount?: number | null; error?: string; alreadyAttempted?: boolean };
            if (cancelled) return;
            if (startData.abandonedOutcome && "score" in startData.abandonedOutcome) {
              submittedRef.current = true;
              setOutcome({ ...startData.abandonedOutcome, autoSubmitted: true });
              setAlreadyAttempted(true);
              return;
            }
            if (startResponse.ok && data.exam) {
              // Locked server order replaces the preview list.
              if (Array.isArray(startData.questions) && startData.questions.length > 0) {
                if (!cancelled) setQuestions(startData.questions);
              }
              if (typeof startData.totalQuestionCount === "number" && !cancelled) {
                setTotalQuestionCount(startData.totalQuestionCount);
              }
              if (startData.questionVersion === "bangla" || startData.questionVersion === "english") {
                if (!cancelled) setQuestionVersion(startData.questionVersion);
              } else if (!cancelled) {
                setQuestionVersion(startVersion);
              }
              activateSession(
                startData.sessionToken ?? null,
                data.exam.durationMinutes,
                startData.secondsLeft ?? null,
                {
                  expiresAt: startData.expiresAt ?? null,
                  serverNow: startData.serverNow ?? null,
                  storedAnswers: startData.storedAnswers ?? null,
                },
              );
              void syncPending(startData.sessionToken ?? null);
            } else if (startResponse.status === 403 && (startData as { alreadyAttempted?: boolean }).alreadyAttempted) {
              // Backend enforced one-attempt — show View Result
              setAlreadyAttempted(true);
              try {
                const resultRes = await fetch(`/api/exams/${encodeURIComponent(examId)}/result`, {
                  headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
                  cache: "no-store",
                });
                const resultData = (await resultRes.json().catch(() => ({}))) as SubmissionOutcome & { error?: string };
                if (!cancelled && resultRes.ok && "score" in resultData) {
                  setOutcome(resultData as SubmissionOutcome);
                }
              } catch {
                // ignore
              }
            } else if (!startResponse.ok) {
              if (!cancelled) setLoadError((startData as { error?: string }).error ?? "Could not start the exam. Please retry.");
            }
          } catch {
            if (!cancelled) setLoadError("Failed to start the exam. Please retry.");
          }
        }
      } catch {
        if (!cancelled) setLoadError("Failed to load the exam. Please retry.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profileLoading, user, examId, autoBegin, activateSession, timerType, versionFromUrl, syncPending]);

  // ── Exam Navigation Lock: hide BottomNav + block navigation during active attempt ──
  // Also locked while the begin=1 flow is preparing the paper, so no exam
  // metadata/counts/timer leak onto the screen before questions are ready.
  // NOTE: lock intentionally lifts once the outcome shows (free navigation
  // after submit) — the page-level exam info is hidden separately below.
  useEffect(() => {
    const preparing = autoBegin && loading;
    const locked = (begun || preparing) && !outcome && !terminatedNotice && !alreadyAttempted;
    setExamLocked(locked);
    return () => setExamLocked(false);
  }, [begun, outcome, terminatedNotice, alreadyAttempted, autoBegin, loading, setExamLocked]);

  // After submission the result card is the whole screen: flag the document
  // so the exam page's own info header (banner + details, rendered above
  // this component) stays hidden instead of reappearing over the result.
  useEffect(() => {
    try {
      if (outcome) {
        document.documentElement.setAttribute("data-exam-result", "true");
      } else {
        document.documentElement.removeAttribute("data-exam-result");
      }
    } catch {
      // Non-fatal.
    }
    return () => {
      try {
        document.documentElement.removeAttribute("data-exam-result");
      } catch {
        // Non-fatal.
      }
    };
  }, [outcome]);

  // Online / offline tracking (non-blocking banner; offline never submits).
  useEffect(() => {
    const update = () => {
      const isOnline = navigator.onLine;
      setOnline(isOnline);
      if (isOnline) void syncPending();
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [syncPending]);

  // Countdown display from the FIXED server-side expires_at.
  // remaining = expires_at - (now + serverOffset). Refresh-safe: reload
  // re-fetches expires_at, so the timer continues from the original expiry.
  // Auto-submit ONLY at 00:00 (actual expiry) — never on hide/offline/close.
  useEffect(() => {
    if (!begun || outcome || terminatedNotice) return;
    if (secondsLeft !== null && secondsLeft <= 0) {
      void submit(true);
      return;
    }
    const iv = setInterval(() => {
      if (expiresAtRef.current !== null) {
        const remaining = Math.max(
          0,
          Math.round((expiresAtRef.current - (Date.now() + serverOffsetRef.current)) / 1000),
        );
        setSecondsLeft((prev) => (prev === remaining ? prev : remaining));
        if (remaining <= 0) {
          clearInterval(iv);
          void submit(true);
        }
      }
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [begun, outcome, terminatedNotice, submit]);

  // Exam Fixed Header positioning — keep it directly below the normal website header (sticky Navbar).
  // Measures the live header height so the sticky exam header sticks at the correct offset and never overlaps the Navbar.
  // Measured ONLY on real layout changes (resize / header resize) — never on
  // scroll — so the sticky offset stays perfectly stable while scrolling and
  // the bar never shifts with the page content.
  useEffect(() => {
    if (!begun || outcome || terminatedNotice) return;
    function updateOffsets() {
      const header = document.querySelector("header");
      if (header) {
        // Navbar is sticky top-0; its height is the offset where the exam header should stick
        const h = Math.round(header.getBoundingClientRect().height);
        if (h > 0) setHeaderOffset((prev) => (prev === h ? prev : h));
      }
    }
    updateOffsets();
    window.addEventListener("resize", updateOffsets);
    // also observe announcement dismissal / header height changes
    const ro = new ResizeObserver(updateOffsets);
    const headerEl = document.querySelector("header");
    if (headerEl) ro.observe(headerEl);
    return () => {
      window.removeEventListener("resize", updateOffsets);
      ro.disconnect();
    };
  }, [begun, outcome, terminatedNotice]);

  // Close/leave protection: warn only — NEVER submit on close/hide.
  // Refresh / close / tab-switch keeps the server attempt alive; the student
  // resumes from the fixed expires_at on return. Answers are already stored
  // per-question, so nothing is lost.
  useEffect(() => {
    const active = begun && !outcome && !terminatedNotice && !alreadyAttempted;
    if (!active) return;
    const warningText = "Your exam is in progress. You can safely leave — your answers are saved and the timer continues from the server.";
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (submittedRef.current) return;
      e.preventDefault();
      e.returnValue = warningText;
      return warningText;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [begun, outcome, terminatedNotice, alreadyAttempted]);

  // Presence heartbeat (every 20s) + revalidate on tab-visible.
  // Records last_seen; surfaces expiry (now >= expires_at) as the result.
  // Silence/offline/hidden NEVER submits — the next beat just retries.
  useEffect(() => {
    const active = begun && !outcome && !terminatedNotice && !alreadyAttempted;
    if (!active || !user) return;
    let stopped = false;
    const pullStoredResult = async (): Promise<boolean> => {
      try {
        const authToken = await user.getIdToken();
        if (stopped) return false;
        const rRes = await fetch(`/api/exams/${encodeURIComponent(examId)}/result`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          cache: "no-store",
        });
        const rData = (await rRes.json().catch(() => ({}))) as SubmissionOutcome & { error?: string };
        if (stopped) return false;
        if (rRes.ok && "score" in rData) {
          submittedRef.current = true;
          setOutcome(rData as SubmissionOutcome);
          return true;
        }
      } catch {
        // ignore — stay on the exam, next beat retries
      }
      return false;
    };
    const beat = async () => {
      if (stopped || submittedRef.current) return;
      try {
        const authToken = await user.getIdToken();
        if (stopped || submittedRef.current) return;
        const res = await fetch(`/api/exams/${encodeURIComponent(examId)}/heartbeat`, {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          status?: "ok" | "abandoned" | "submitted" | "expired";
          outcome?: SubmissionOutcome;
          secondsLeft?: number | null;
          expiresAt?: string | null;
          serverNow?: string | null;
        };
        if (stopped || submittedRef.current) return;
        if ((data.status === "abandoned" || data.status === "expired") && data.outcome && "score" in data.outcome) {
          // Server reached expires_at while we were away — show result.
          submittedRef.current = true;
          setOutcome({ ...data.outcome, autoSubmitted: true });
        } else if (data.status === "submitted") {
          submittedRef.current = true;
          const shown = await pullStoredResult();
          if (!shown) submittedRef.current = false; // result not ready yet — stay on exam
        } else if (data.status === "ok") {
          // Re-anchor the display timer to the authoritative expiry
          // (corrects drift after sleep/offline without resetting anything).
          if (data.expiresAt) {
            const expMs = new Date(data.expiresAt).getTime();
            if (!Number.isNaN(expMs)) {
              expiresAtRef.current = expMs;
              const srvMs = data.serverNow ? new Date(data.serverNow).getTime() : NaN;
              if (!Number.isNaN(srvMs)) serverOffsetRef.current = srvMs - Date.now();
              const remaining = Math.max(0, Math.round((expMs - (Date.now() + serverOffsetRef.current)) / 1000));
              setSecondsLeft(remaining);
              if (remaining <= 0) void submit(true);
            }
          }
          // Back online with queued answers → push them now.
          void syncPending();
        }
      } catch {
        // Offline — stay on the exam; the next beat retries.
      }
    };
    void beat();
    const iv = setInterval(() => void beat(), 20000);
    const onVisibility = () => {
      // Return-to-tab: revalidate expiry + resync — NEVER submit on hide.
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [examId, user, begun, outcome, terminatedNotice, alreadyAttempted, submit, syncPending]);

  /** Select an answer — allowed only once per question, no changing later. */
  async function chooseOption(question: TakingQuestion, optionIndex: number) {
    // Per-question lock ONLY: this guard touches question.id alone.
    // - answersRef (synchronous) is authoritative so rapid taps on the same
    //   question can never overwrite the first selection before re-render.
    // - submitting/outcome never lock OTHER questions; they only stop new picks.
    if (answersRef.current[question.id] !== undefined || submitting || outcome) return;
    // Lock locally right away — option-circle selection IS the lock mechanism.
    const next = { ...answersRef.current, [question.id]: optionIndex };
    answersRef.current = next;
    setAnswers(next);

    // Server-side enforcement + storage. Offline → queue as pending_sync.
    if (tokenRef.current && user) {
      // Mark pending immediately so a mid-request disconnect can't lose it.
      try {
        const pending = loadPending();
        pending[String(question.id)] = optionIndex;
        savePending(pending);
      } catch {}
      try {
        const authToken = await user.getIdToken();
        const response = await fetch(
          `/api/exams/${encodeURIComponent(examId)}/answer`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              token: tokenRef.current,
              questionId: question.id,
              optionIndex,
            }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          accepted?: boolean;
          terminated?: boolean;
          autoSubmitted?: boolean;
          outcome?: SubmissionOutcome;
          error?: string;
        };
        if (data.autoSubmitted && data.outcome) {
          // Hit expires_at mid-answer — show the auto-submitted result.
          submittedRef.current = true;
          setOutcome({ ...data.outcome, autoSubmitted: true });
          return;
        }
        if (response.ok || response.status === 409) {
          // Stored (or already locked server-side) → clear from queue.
          try {
            const pending = loadPending();
            delete pending[String(question.id)];
            savePending(pending);
          } catch {}
        }
        if (data.terminated && data.outcome) {
          // Attempt already finalized elsewhere — show its result.
          submittedRef.current = true;
          setTerminatedNotice(true);
          setOutcome(data.outcome);
          return;
        }
      } catch {
        // Offline: answer stays in answersRef + pending_sync queue; the final
        // submit and syncPending() carry it when the connection returns.
      }
    } else {
      // No session token yet (shouldn't happen mid-exam) — keep locally and
      // queue for sync.
      try {
        const pending = loadPending();
        pending[String(question.id)] = optionIndex;
        savePending(pending);
      } catch {}
    }
  }

  const openAnswerScript = async () => {
    if (script) {
      setScriptOpen(true);
      return;
    }
    try {
      if (!user) return;
      const token = await user.getIdToken();
      const response = await fetch(
        examResultApiPath(examId, outcome?.questionVersion ?? questionVersion),
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
        },
      );
      const data = (await response.json().catch(() => ({}))) as
        | ResultScript
        | { error?: string };
      if ("questions" in data) {
        setScript(data);
        setScriptOpen(true);
      } else {
        setLoadError("error" in data && data.error ? data.error : "Answer script is not available yet.");
      }
    } catch {
      setLoadError("Failed to load the answer script. Please retry.");
    }
  };

  if (authLoading || profileLoading) {
    return <AccessLoading label="Checking access..." />;
  }

  if (!user) {
    return (
      <AccessMessage
        title="Login Required to Start Exams"
        message="You can view this Public Exam without an account, but you must be logged in to start or submit an exam."
        actionLabel="Login to Start Exam"
        actionHref={loginHref}
      />
    );
  }

  // Registration (completed student profile) is required to participate.
  if (!profile) {
    return (
      <AccessMessage
        title="Registration Required to Start Exams"
        message="You can view this Public Exam without an account, but you must complete your student registration to start or submit an exam."
        actionLabel="Complete Registration"
        actionHref="/register"
      />
    );
  }

  if (loading) {
    // Rules → Continue flow: clean preparing screen until questions + exam
    // data are fully ready. Normal visits keep the existing loader.
    if (autoBegin) {
      return <PreparingExamScreen />;
    }
    return <AccessLoading label="Loading exam…" />;
  }

  if (loadError && !outcome) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <p className="font-semibold text-red-400">{loadError}</p>
      </div>
    );
  }

  /* ── Result Card ─────────────────────────────────────────────────────── */

  if (outcome) {
    if (scriptOpen && script) {
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-extrabold text-heading">Answer Script</h3>
              <p className="text-xs text-neutral-400">
                {script.examName}{script.questionVersion ? ` · ${script.questionVersion === "english" ? "English" : "Bangla"} Version` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setScriptOpen(false)}
              className="rounded-xl border border-ink/10 bg-dark-850 px-4 py-2 text-sm font-bold text-neutral-300 transition hover:text-heading"
            >
              ← Back to Result
            </button>
          </div>

          <ol className="exam-questions list-none space-y-4">
            {script.questions.map((item, index) => {
              // An unknown correct answer (null) can never match — the old
              // `65 + null` fallback rendered it as "A"; now it shows "—".
              const isCorrect =
                item.chosenIndex !== null &&
                item.correctIndex !== null &&
                item.chosenIndex === item.correctIndex;
              return (
                <li
                  key={item.questionId}
                  className={`rounded-2xl border p-4 sm:p-5 ${
                    item.chosenIndex === null
                      ? "border-ink/10 bg-dark-900"
                      : isCorrect
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-red-500/30 bg-red-500/5"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-bold leading-relaxed text-heading sm:text-base">
                      {padNum(index + 1)}. {item.question}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${
                        item.chosenIndex === null
                          ? "bg-neutral-500/15 text-neutral-400"
                          : isCorrect
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300"
                      }`}
                    >
                      {item.chosenIndex === null
                        ? "Unanswered"
                        : isCorrect
                          ? "Correct"
                          : "Wrong"}
                    </span>
                  </div>

                  {item.contentFallback === "base" && (
                    <p className="mt-2 text-xs text-amber-300">Showing original content; the translation for this version is unavailable.</p>
                  )}
                  {item.questionImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.questionImage}
                      alt={`Question ${index + 1} image`}
                      className="mt-3 max-h-72 w-full rounded-xl border border-ink/10 object-contain bg-dark-950"
                    />
                  ) : null}

                  <div className="mt-3 space-y-2">
                    {item.options.map((option, optionIndex) => {
                      const chosen = item.chosenIndex === optionIndex;
                      const correct = item.correctIndex === optionIndex;
                      return (
                        <div
                          key={optionIndex}
                          className={`result-option flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-sm font-semibold ${
                            correct
                              ? "result-option--correct border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                              : chosen
                                ? "result-option--chosen border-red-500/50 bg-red-500/10 text-red-200"
                                : "border-ink/10 bg-dark-850 text-neutral-300"
                          }`}
                        >
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${
                              correct
                                ? "bg-emerald-500 text-white"
                                : chosen
                                  ? "bg-red-500 text-white"
                                  : "bg-ink/10 text-neutral-400"
                            }`}
                          >
                            {String.fromCharCode(65 + optionIndex)}
                          </span>
                          <span className="min-w-0 break-words">{option}</span>
                          {correct && (
                            <span className="ml-auto shrink-0 text-[10px] font-extrabold uppercase tracking-wide text-emerald-300">
                              Correct Answer
                            </span>
                          )}
                          {chosen && !correct && (
                            <span className="ml-auto shrink-0 text-[10px] font-extrabold uppercase tracking-wide text-red-300">
                              Your Answer
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] font-semibold">
                    <span className="text-neutral-400">
                      Marks: <span className="text-heading">{item.marks}</span>
                      <span className="ml-2 text-neutral-400">
                        Obtained: <span className={isCorrect ? "text-emerald-400" : "text-neutral-400"}>{isCorrect ? `+${item.marks}` : "0"}</span>
                      </span>
                    </span>
                    <span className="text-neutral-400">
                      Your Answer: <span className="text-heading">{item.chosenIndex == null ? "Not Answered" : String.fromCharCode(65 + item.chosenIndex)}</span>
                    </span>
                    <span className="text-neutral-400">
                      Correct: <span className="text-heading">{answerIndexToLetter(item.correctIndex) ?? "—"}</span>
                    </span>
                  </div>
                  {item.explanation && (
                    <div className="mt-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-200">
                      <span className="font-extrabold">Explanation: </span>
                      {item.explanation}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      );
    }

    return (
      <div className="rounded-2xl border border-primary-600/30 bg-primary-600/10 p-4 text-left sm:p-8">
        {terminatedNotice && (
          <p className="mb-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-center text-sm font-semibold text-yellow-300">
            This exam was started on another device — this session was submitted automatically.
          </p>
        )}
        {outcome.autoSubmitted && (
          <p className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-center text-sm font-semibold text-sky-300">
            Time is up. Your exam has been submitted automatically.
          </p>
        )}

        {/* Result Card */}
        <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-ink/10 bg-dark-900 p-5 sm:p-6">
          {/* 1. Exam Name */}
          <div className="text-center">
            <h3 className="text-lg font-extrabold text-heading">{outcome.examName ?? exam?.name ?? "Exam"}</h3>
          </div>

          {/* 2. Answer Summary */}
          <div className="mx-auto mt-4 grid max-w-md grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-400">Correct Answer</p>
              <p className="mt-1 text-lg font-extrabold text-emerald-300">{outcome.correctCount}</p>
            </div>
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-red-400">Wrong Answer</p>
              <p className="mt-1 text-lg font-extrabold text-red-300">{outcome.wrongCount}</p>
            </div>
            <div className="rounded-xl border border-ink/10 bg-dark-850 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-500">Unanswered</p>
              <p className="mt-1 text-lg font-extrabold text-neutral-300">{outcome.skippedCount}</p>
            </div>
          </div>

          {/* 3. Marks */}
          <div className="mt-4 text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Obtained Marks / Total Marks</p>
            <p className="text-5xl font-extrabold text-primary-300">
              {outcome.score}
              <span className="text-2xl text-neutral-400"> / {outcome.totalMarks}</span>
            </p>
          </div>

          {/* 4. Additional Result Information */}
          <ul className="mt-4 grid gap-2 text-left text-sm">
            <li className="flex items-center justify-between rounded-xl border border-ink/10 bg-dark-850 px-4 py-2.5">
              <span className="font-semibold text-neutral-400">Negative Marking</span>
              {outcome.negativeMarks != null && outcome.negativeMarks > 0 ? (
                <span className="font-extrabold text-red-300">
                  −{outcome.negativeDeduction ?? 0}
                  <span className="ml-1 text-[11px] font-bold text-neutral-500">
                    (−{outcome.negativeMarks} × {outcome.wrongCount} wrong)
                  </span>
                </span>
              ) : (
                <span className="font-extrabold text-neutral-300">0</span>
              )}
            </li>
            <li className="flex items-center justify-between rounded-xl border border-ink/10 bg-dark-850 px-4 py-2.5">
              <span className="font-semibold text-neutral-400">Second Timer Penalty</span>
              {outcome.secondTimer ? (
                <span className="font-extrabold text-red-300">
                  −{outcome.timerPenalty ?? 0}
                  <span className="ml-1 text-[11px] font-bold text-neutral-500">(repeat attempt)</span>
                </span>
              ) : (
                <span className="font-extrabold text-neutral-300">0</span>
              )}
            </li>
            <li className="flex items-center justify-between rounded-xl border border-ink/10 bg-dark-850 px-4 py-2.5">
              <span className="font-semibold text-neutral-400">Time</span>
              <span className="font-extrabold text-heading">{formatTimeTaken(outcome.timeTakenSeconds)}</span>
            </li>
            <li className="flex items-center justify-between rounded-xl border border-ink/10 bg-dark-850 px-4 py-2.5">
              <span className="font-semibold text-neutral-400">Merit</span>
              <span className="font-extrabold text-primary-300">{outcome.meritPosition != null ? `#${outcome.meritPosition}` : "—"}</span>
            </li>
            {outcome.highestMark != null && (
              <li className="flex items-center justify-between rounded-xl border border-ink/10 bg-dark-850 px-4 py-2.5">
                <span className="font-semibold text-neutral-400">Highest Mark</span>
                <span className="font-extrabold text-heading">{outcome.highestMark}</span>
              </li>
            )}
          </ul>
        </div>

        {/* 5. Action Buttons */}
        <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => void openAnswerScript()}
            className="w-full rounded-xl bg-primary-600 px-6 py-3 text-sm font-extrabold text-white shadow-lg shadow-primary-900/40 transition hover:bg-primary-500 active:scale-[0.98] sm:w-auto"
          >
            View Question Paper Details
          </button>
          <a
            href="/dashboard"
            className="w-full rounded-xl border border-ink/10 bg-dark-850 px-6 py-3 text-center text-sm font-bold text-neutral-300 transition hover:text-heading sm:w-auto"
          >
            Go to Dashboard
          </a>
        </div>
      </div>
    );
  }

  /* ── Exam Rules gate ─────────────────────────────────────────────────── */
  // totalQuestionCount covers stripped previews: start fetches the locked
  // questions, so the gate must show even when preview content was withheld.

  if (exam && !begun && (questions.length > 0 || (totalQuestionCount ?? 1) > 0)) {
    return (
      <div className="rounded-2xl border border-primary-600/30 bg-dark-900 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-extrabold text-heading">Exam Rules</h3>
          <span className="rounded-full bg-primary-600/15 px-3 py-1 text-[11px] font-bold text-primary-300">
            Read carefully before starting
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-400">{exam.name}</p>

        {/* Post-live Practice phase — clearly distinguished from the Live Exam. */}
        {exam.isPostLivePractice && (
          <div className="mt-4 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3">
            <p className="text-sm font-extrabold text-violet-300">Practice Exam — the live window has ended</p>
            <p className="mt-1 text-xs leading-relaxed text-violet-200/80">
              You can still take this exam as practice and see your own result, but this attempt will not affect the leaderboard, merit position, or live ranking.
            </p>
          </div>
        )}

        <div className="mt-4">
          {(() => {
            const lang = questionVersion ?? versionFromUrl ?? "bangla";
            const rows = lang === "english" ? (dbRulesEn ?? dbRules) : (dbRules ?? dbRulesEn);
            if (rows && rows.length > 0) {
              return (
                <ul className="space-y-3">
                  {rows.map((rule, index) => (
                    <li
                      key={rule.id ?? `rule-${index}`}
                      className="flex gap-3 rounded-xl border border-ink/10 bg-dark-850 p-3.5"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600/15 text-xs font-extrabold text-primary-300">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        {rule.title && (
                          <p className="text-sm font-bold text-heading">{rule.title}</p>
                        )}
                        <p className={`text-xs leading-relaxed text-neutral-400 sm:text-sm ${rule.title ? "mt-0.5" : ""}`}>
                          {rule.text}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            }
            return <ExamRulesList exam={exam} />;
          })()}
        </div>

        {/* Question Version — required; locked server-side once the exam starts */}
        <div className="mt-5 rounded-2xl border border-primary-600/30 bg-dark-850 p-4 sm:p-5">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-heading">
            Question Version
            <span className="rounded-full bg-primary-600/15 px-2.5 py-0.5 text-[10px] font-bold text-primary-300">Required</span>
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-neutral-400">
            Choose the language version for this exam. Your version is locked after you start — it cannot be changed during the exam.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {([
              { key: "bangla", title: "Bangla Version", hint: "Bangla / English / mixed" },
              { key: "english", title: "English Version", hint: "English" },
            ] as const).map((option) => {
              const selected = (questionVersion ?? versionFromUrl) === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setQuestionVersion(option.key)}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
                    selected
                      ? "border-primary-500/60 bg-primary-600/10 ring-1 ring-primary-500/30"
                      : "border-ink/10 bg-dark-900 hover:border-primary-500/30"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-extrabold ${
                      selected ? "border-primary-500 bg-primary-600 text-white" : "border-ink/20 bg-dark-850 text-neutral-400"
                    }`}
                  >
                    {selected ? "●" : "○"}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-extrabold text-heading">{option.title}</p>
                    <p className="text-xs text-neutral-400">{option.hint}</p>
                  </div>
                </button>
              );
            })}
          </div>
          {!(questionVersion ?? versionFromUrl) && (
            <p className="mt-2 text-xs font-semibold text-amber-400">Please select a Question Version to continue.</p>
          )}
        </div>

        <button
          type="button"
          disabled={beginning || !(questionVersion ?? versionFromUrl)}
          onClick={() => void beginExam()}
          title={!(questionVersion ?? versionFromUrl) ? "Select a Question Version first" : undefined}
          className="mt-6 w-full rounded-xl bg-primary-600 px-6 py-3.5 text-sm font-extrabold text-white shadow-lg shadow-primary-900/40 transition hover:bg-primary-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {beginning ? "Starting…" : "I Understand & Start Exam"}
        </button>
        <p className="mt-2 text-center text-xs text-neutral-500">
          The timer starts as soon as you press this button.
        </p>
      </div>
    );
  }

  // Truly question-less only when the server confirms zero active rows —
  // a stripped preview (totalQuestionCount > 0) falls through to the begin
  // gate above instead of this dead end.
  if (!exam || (questions.length === 0 && totalQuestionCount === 0)) {
    return (
      <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-6 text-center">
        <p className="font-semibold text-yellow-300">
          No questions have been added to this exam yet.
        </p>
      </div>
    );
  }

  /* ── Active exam — Single scrollable paper ─────────────────────────── */

  const answeredCount = Object.keys(answers).length;
  const totalQuestions = questions.length;
  const totalMarks = questions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0);
  const unansweredCount = totalQuestions - answeredCount;

  return (
    <div className="space-y-4">
      {/* Connection status — non-blocking; offline NEVER submits. */}
      {!online && begun && !outcome && (
        <div
          role="alert"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-center text-xs font-bold text-amber-300"
        >
          ⚠ Internet connection lost. Your exam has not been submitted. Reconnect to continue — your answers are saved.
        </div>
      )}
      {online && reconnecting && begun && !outcome && (
        <div
          role="status"
          className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-center text-xs font-bold text-sky-300"
        >
          Reconnecting… syncing your answers.
        </div>
      )}
      {online && begun && !outcome && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-1.5 text-center text-[11px] font-bold text-emerald-300">
          ✓ Connected — timer follows the server (refresh-safe).
        </div>
      )}
      {/* Exam Fixed Header — separate sticky header directly below the normal website header.
          Must remain permanently visible while scrolling: uses sticky with dynamic top (Navbar height).
          Placed OUTSIDE the scrollable question-paper container, questions scroll underneath.
          LEFT: Answered X/Y (same answeredCount) | RIGHT: live countdown (same secondsLeft state). */}
      <div
        className="sticky z-40 -mx-4 border-b border-ink/10 bg-dark-950/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-dark-950/80 sm:-mx-6 sm:px-6"
        style={{ top: `${headerOffset}px`, transform: "translateZ(0)" }}
        role="region"
        aria-label="Exam progress and timer"
      >
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-sm font-bold text-heading sm:text-[15px]">
              Answered {answeredCount}/{totalQuestions}
            </span>
            {questionVersion && (
              <span className="hidden shrink-0 whitespace-nowrap rounded-full border border-primary-500/20 bg-primary-600/10 px-2 py-0.5 text-[10px] font-extrabold capitalize text-primary-300 sm:inline-block">
                {questionVersion} Version · Locked
              </span>
            )}
          </span>
          <span
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 font-mono text-sm font-extrabold tabular-nums sm:px-4 sm:text-base ${
              secondsLeft !== null && secondsLeft < 60
                ? "bg-red-500/15 text-red-400"
                : "bg-primary-600/15 text-primary-300"
            }`}
          >
            {formatClock(secondsLeft ?? 0)}
          </span>
        </div>
      </div>

      {/* Exam paper — all questions vertically, free scroll. Has top spacing so first question never hidden underneath the sticky header */}
      <div className="rounded-2xl border border-ink/10 bg-dark-900 p-4 sm:p-6">

        {/* Questions list */}
        <ol className="exam-questions mt-6 list-none space-y-6">
          {questions.map((q, idx) => {
            // ── Per-question answer lock ──────────────────────────
            // The ONLY lock signal is THIS question's own id in the answers
            // map: answers[question.id] → the selected option index.
            // There is intentionally NO global/module-level `isLocked` boolean —
            // answering Q1 locks Q1 alone; Q2/Q3/… stay fully selectable.
            const selectedIndex = answers[q.id];
            const isQuestionLocked = selectedIndex !== undefined;
            const isUnanswered = !isQuestionLocked;
            return (
              <li
                key={q.id}
                id={`q-${q.id}`}
                className={`rounded-2xl border p-4 sm:p-5 ${isQuestionLocked ? "border-primary-500/25 bg-primary-600/[0.04]" : "border-ink/10 bg-dark-850/50"}`}
              >
                {/* Question header */}
                <div className="flex items-start justify-between gap-3">
                  <p className="flex-1 text-sm font-bold leading-relaxed text-heading sm:text-[15px]">
                    <span className="mr-2 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-dark-800 px-1.5 text-xs font-extrabold text-neutral-300 sm:h-7 sm:px-2">
                      {padNum(idx + 1)}
                    </span>
                    {q.question}
                  </p>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${
                      isUnanswered
                        ? "bg-amber-500/15 text-amber-300 border border-amber-500/20"
                        : "bg-primary-600/15 text-primary-300 border border-primary-500/20"
                    }`}
                  >
                    {isUnanswered ? "Not Answered" : "Locked"}
                  </span>
                </div>

                {q.questionImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={q.questionImage}
                    alt={`Question ${idx + 1} image`}
                    className="mt-3 max-h-72 w-full rounded-xl border border-ink/10 object-contain bg-dark-950"
                  />
                ) : null}

                <p className="mt-2 text-xs font-semibold text-neutral-500">Marks: {q.marks}</p>

                {/* Options — ○ circle style, one-time lock */}
                <div className="mt-3 space-y-2">
                  {q.options.map((option, optionIndex) => {
                    const isSelected = selectedIndex === optionIndex;
                    // Per-question ONLY: an answered question disables ITS OWN
                    // options; unanswered questions are NEVER disabled (no global
                    // boolean may freeze the whole paper — chooseOption itself
                    // already ignores taps while submitting).
                    const disabled = isQuestionLocked;
                    // Unanswered: all options are enabled. Answered: selected shows locked, others disabled grey.
                    return (
                      <button
                        key={optionIndex}
                        type="button"
                        disabled={disabled}
                        onClick={() => void chooseOption(q, optionIndex)}
                        className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left text-sm font-semibold transition sm:px-4 ${
                          isSelected
                            ? "border-primary-500 bg-primary-600/15 text-heading shadow-sm"
                            : isQuestionLocked
                              ? "border-ink/10 bg-dark-800 text-neutral-300 cursor-not-allowed"
                              : "border-ink/10 bg-dark-900 text-neutral-300 hover:border-primary-500/40 hover:bg-dark-800"
                        }`}
                      >
                        {/* Circle */}
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-extrabold transition ${
                            isSelected
                              ? "border-primary-500 bg-primary-600 text-white"
                              : isQuestionLocked
                                ? "border-ink/20 bg-dark-800 text-neutral-400"
                                : "border-ink/20 bg-dark-850 text-neutral-400"
                          }`}
                        >
                          {isSelected ? "●" : "○"}
                        </span>
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[11px] font-extrabold text-neutral-400">
                          {String.fromCharCode(65 + optionIndex)}
                        </span>
                        <span className="min-w-0 flex-1 break-words font-bold">{option}</span>
                        {isSelected && (
                          <span className="ml-auto shrink-0 rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-bold text-white">
                            Locked
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <p className="mt-2.5 text-xs font-medium text-neutral-500">
                  {isQuestionLocked ? "Answer saved — locked permanently." : "Select one option — it will lock immediately and cannot be changed."}
                </p>
              </li>
            );
          })}
        </ol>

        {/* Bottom submit */}
        <div className="mt-8 flex flex-col items-center gap-3 border-t border-ink/10 pt-6 sm:flex-row sm:justify-between">
          <p className="text-xs font-semibold text-neutral-400">
            Answered <span className="font-extrabold text-primary-300">{answeredCount}</span> / {totalQuestions} · Unanswered{" "}
            <span className="font-extrabold text-amber-300">{unansweredCount}</span>
          </p>
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
            {submitError && (
              <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-center text-xs font-bold text-red-300 sm:text-right">
                {submitError}
              </p>
            )}
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setSubmitError(null);
                if (window.confirm("Are you sure you want to submit the exam?")) {
                  void submit(false);
                }
              }}
              className="w-full rounded-xl bg-emerald-600 px-8 py-3 text-sm font-extrabold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-700 disabled:opacity-50 sm:w-auto"
            >
              {submitting ? "Submitting…" : "Submit Exam"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
