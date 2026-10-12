"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { hasControlAccess, useAdminGate } from "@/components/admin/admin-ui";
import { SearchIcon } from "@/components/admin/icons";

type SearchEntry = {
  label: string;
  href: string;
  section: string;
};

// Mirrors the CURRENT sidebar (AdminShell ADMIN_NAV) — every entry must be a
// real page, otherwise search suggests dead links that never redirect.
const SEARCH_INDEX: SearchEntry[] = [
  { label: "HOME", href: "/admin", section: "Section" },
  { label: "Website Control", href: "/admin/website-information", section: "Website" },
  { label: "Enrollment Control", href: "/admin/enrollment-control", section: "Enrollment" },
  { label: "Home Page Control", href: "/admin/home-control", section: "Website" },
  { label: "Course Control", href: "/admin/course-control", section: "Courses" },
  { label: "Course Content Control", href: "/admin/course-content-control", section: "Courses" },
  { label: "Material PDF Generator", href: "/admin/material-pdf", section: "Courses" },
  { label: "Free Exam Control", href: "/admin/public-exam-control", section: "Exams" },
  { label: "Exam Rules", href: "/admin/exam-rules", section: "Exams" },
  { label: "Paste Format", href: "/admin/exam-paste-format", section: "Exams" },
  { label: "Question Bank", href: "/admin/exams/question-bank", section: "Exams" },
  { label: "Answer Keys", href: "/admin/exams/answer-keys", section: "Exams" },
  { label: "Exam Results", href: "/admin/exams/results", section: "Exams" },
  { label: "Exam Settings", href: "/admin/exams/settings", section: "Exams" },
  { label: "Coupons", href: "/admin/courses/coupons", section: "Courses" },
  { label: "Q&A Control", href: "/admin/qa-control", section: "Content" },
  { label: "Dashboard Control", href: "/admin/dashboard-control", section: "Website" },
  { label: "Student Control", href: "/admin/student-control", section: "Students" },
  { label: "Result Control", href: "/admin/result-control", section: "Results" },
  { label: "Result Board", href: "/admin/result-control/board", section: "Results" },
  { label: "Notification Control", href: "/admin/notification-control", section: "Content" },
  { label: "Readme", href: "/admin/rules", section: "System" },
  { label: "Admin Center", href: "/admin/admin-center", section: "System" },
  { label: "My Profile", href: "/admin/profile", section: "Account" },
  { label: "General Settings", href: "/admin/settings", section: "Website" },
  { label: "Contact Information", href: "/admin/website/contact", section: "Website" },
  { label: "Footer", href: "/admin/website/footer", section: "Website" },
  { label: "Social Links", href: "/admin/website/social-links", section: "Website" },
  { label: "SEO Settings", href: "/admin/website/seo", section: "Website" },
];

export default function AdminSearch({
  autoFocus = false,
  onNavigate,
}: {
  autoFocus?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const gate = useAdminGate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    // RBAC: only suggest sections the current role can actually open.
    // While gate is resolving, show nothing (fail-closed) so search never
    // suggests a section that the route guard would later block.
    if (!gate.ready) return [];
    const entries = SEARCH_INDEX.filter((entry) =>
      hasControlAccess(gate.role, gate.permissions, entry.href),
    );
    return entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(trimmed) ||
        entry.section.toLowerCase().includes(trimmed)
    ).slice(0, 8);
  }, [query, gate.ready, gate.role, gate.permissions]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function go(href: string) {
    setQuery("");
    setOpen(false);
    onNavigate?.();
    router.push(href);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <label className="flex items-center gap-2 rounded-xl border border-[#dbeafe] bg-[#f8fbff] px-3 py-2 transition focus-within:border-[#2f6bce] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#2f6bce]/10 md:flex admin-dark:border-[#1e3a65] admin-dark:bg-[#132a4f] admin-dark:focus-within:border-[#2f5aa0] admin-dark:focus-within:bg-[#0f2547]">
        <SearchIcon className="h-4 w-4 shrink-0 text-[#1a3a78] admin-dark:text-[#93c5fd]" />
        <input
          type="search"
          autoFocus={autoFocus}
          value={query}
          placeholder="Search sections…"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results.length > 0) {
              go(results[0].href);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          aria-label="Search Admin Panel sections"
          className="w-full min-w-0 bg-transparent text-sm text-[#0b1e3a] outline-none placeholder:text-slate-400 admin-dark:text-slate-100 admin-dark:placeholder:text-slate-500"
        />
      </label>

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-[#dbeafe] bg-white shadow-xl shadow-[#0b1e3a]/10 admin-dark:border-[#1e3a65] admin-dark:bg-[#112544]">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-sm font-semibold text-slate-500 admin-dark:text-[#8da0c0]">
              No matching sections found.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((entry) => (
                <li key={entry.label + entry.href}>
                  <button
                    type="button"
                    onClick={() => go(entry.href)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-[#f8fbff] admin-dark:hover:bg-[#132a4f]"
                  >
                    <span className="min-w-0 truncate text-sm font-semibold text-[#0b1e3a] admin-dark:text-slate-200">
                      {entry.label}
                    </span>
                    <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400 admin-dark:text-[#8da0c0]">
                      {entry.section}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
