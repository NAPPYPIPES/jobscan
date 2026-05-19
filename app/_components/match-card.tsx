"use client";

import { memo, useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { Match, DismissReason } from "@/db/schema";
import type { Level } from "@/lib/scan/types";
import type { Role } from "@/lib/auth/viewer";
import { logoUrl } from "@/lib/scan/logos";

// Apply URL is pre-computed server-side (in page.tsx / all/page.tsx)
// and threaded onto each row. Keeps the client bundle free of
// @/lib/scan/urls → @/lib/scan/workday-config → @/lib/config/load,
// which pulls node:fs.
export type MatchWithUrl = Match & { applyUrl: string };

// Tooltip applied to every disabled mutation control in demo mode.
// Server-side requireOwner() is the real gate; this is just UX
// surfacing of why the buttons don't respond.
const DEMO_TOOLTIP = "Demo mode — actions disabled. Fork to make it yours.";

type SummaryData = {
  summary: string;
  pros: string[];
  cons: string[];
  cached: boolean;
  generated_at: string;
};

const LEVEL_PILL: Record<Level, string> = {
  BV: "bg-indigo-50 text-indigo-700 ring-indigo-200/70 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-400/20",
  HIGH: "bg-rose-50 text-rose-700 ring-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20",
  MEDIUM: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20",
  LOW: "bg-stone-100 text-stone-600 ring-stone-200 dark:bg-stone-800/60 dark:text-stone-300 dark:ring-stone-700",
};

const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 24 * 3_600_000;

function fitBadgeClass(score: number): string {
  if (score >= 8.0) return "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20";
  if (score >= 6.0) return "bg-amber-50 text-amber-700 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20";
  return "bg-stone-100 text-stone-500 ring-stone-200 dark:bg-stone-800/60 dark:text-stone-400 dark:ring-stone-700";
}

function ReasonCheckbox({
  value,
  selected,
  onToggle,
  label,
}: {
  value: DismissReason;
  selected: boolean;
  onToggle: (v: DismissReason) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(value)}
        className="h-3 w-3 cursor-pointer accent-rose-600"
      />
      <span className={selected ? "text-fg" : "text-fg-muted"}>{label}</span>
    </label>
  );
}

// Wrapped in React.memo at the bottom of the file. Skips re-render
// when props are reference-equal, which matters because the parent
// (MatchesView) re-renders whenever the URL changes (filters, sort,
// search) — without memo, every keystroke in the search box would
// re-render every visible MatchCard.
//
// onToggleSummary takes the id rather than being pre-bound by the
// parent. This lets the parent pass a SINGLE stable callback (via
// useCallback) instead of creating one closure per card per render
// (which would defeat memo).
//
// showCompanyLogo + companyDomain: opt-in row prefix used by the
// flat score-sort view. Off by default (the company section header
// already shows the logo when grouped). When on, renders a 24px logo
// at the start of the row so the user can identify the company
// without the section header.
function MatchCardImpl({
  m,
  isSummaryOpen,
  onToggleSummary,
  viewerRole,
  showCompanyLogo = false,
  companyDomain,
}: {
  m: MatchWithUrl;
  isSummaryOpen: boolean;
  onToggleSummary: (id: string) => void;
  viewerRole: Role;
  showCompanyLogo?: boolean;
  companyDomain?: string;
}) {
  const isDemo = viewerRole === "demo";
  const href = m.applyUrl;
  const router = useRouter();
  const [applied, setApplied] = useState(m.status === "applied");
  const [mode, setMode] = useState<"idle" | "picking">("idle");
  const [reasons, setReasons] = useState<Set<DismissReason>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  const [summaryData, setSummaryData] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Demo mode disables both interactive AND spend-burning paths:
  // can't apply, can't dismiss, can't fetch a fresh AI summary
  // (each summary call costs real $ on the owner's API key).
  const canSummarize = m.level !== "LOW" && !isDemo;

  // Fetch the summary the first time the card is opened. Deps are
  // narrow on purpose — state setters are NOT in deps. Including them
  // would cause setSummaryLoading(true) to fire the cleanup, set
  // cancelled=true, and abort the in-flight fetch.
  useEffect(() => {
    if (!isSummaryOpen || !canSummarize) return;
    if (summaryData || summaryLoading || summaryError) return;
    let cancelled = false;
    setSummaryLoading(true);
    setSummaryError(null);
    fetch(`/api/matches/${m.id}/summarize`, { method: "POST" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res
            .json()
            .catch(() => ({} as { error?: string; detail?: string }));
          const msg = (body as { error?: string; detail?: string }).detail
            ?? (body as { error?: string }).error
            ?? `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const data = (await res.json()) as SummaryData;
        if (!cancelled) setSummaryData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setSummaryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSummaryOpen, canSummarize, m.id]);

  const onRegenerate = () => {
    setSummaryLoading(true);
    setSummaryError(null);
    setSummaryData(null);
    fetch(`/api/matches/${m.id}/summarize?force=true`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({} as { error?: string }));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as SummaryData;
        setSummaryData(data);
      })
      .catch((err) =>
        setSummaryError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSummaryLoading(false));
  };

  const toggleReason = (v: DismissReason) => {
    setReasons((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const onToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !applied;
    setApplied(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/matches/${m.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next ? "applied" : "new" }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        router.refresh();
      } catch (err) {
        console.error("Failed to update applied status", err);
        setApplied(!next);
      }
    });
  };

  const onDismissClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setMode("picking");
  };

  const onConfirmDismiss = () => {
    setDismissed(true);
    const picked = Array.from(reasons);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/matches/${m.id}/dismiss`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(picked.length > 0 ? { reasons: picked } : {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        router.refresh();
      } catch (err) {
        console.error("Failed to dismiss role", err);
        setDismissed(false);
        setMode("idle");
      }
    });
  };

  const onCancelDismiss = () => {
    setReasons(new Set());
    setMode("idle");
  };

  if (dismissed) return null;

  if (mode === "picking") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-card">
        <span className="shrink-0 text-xs font-medium text-fg">Wrong:</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <ReasonCheckbox value="wrong_function" selected={reasons.has("wrong_function")} onToggle={toggleReason} label="Function" />
          <ReasonCheckbox value="wrong_level"    selected={reasons.has("wrong_level")}    onToggle={toggleReason} label="Level" />
          <ReasonCheckbox value="wrong_company"  selected={reasons.has("wrong_company")}  onToggle={toggleReason} label="Company" />
          <ReasonCheckbox value="wrong_location" selected={reasons.has("wrong_location")} onToggle={toggleReason} label="Location" />
          <ReasonCheckbox value="not_interested" selected={reasons.has("not_interested")} onToggle={toggleReason} label="Not interested" />
        </div>
        <button
          type="button"
          onClick={onConfirmDismiss}
          disabled={pending}
          className="shrink-0 rounded bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onCancelDismiss}
          disabled={pending}
          className="shrink-0 rounded bg-muted px-2.5 py-1 text-xs font-medium text-fg-muted hover:text-fg disabled:cursor-wait"
        >
          Cancel
        </button>
      </div>
    );
  }

  const isStale = Date.now() - m.firstSeen.getTime() > STALE_MS;
  const fitScore = m.fitScore != null ? parseFloat(m.fitScore) : null;

  return (
    <div
      className={`group surface-hover rounded-lg border border-line bg-surface shadow-card ${
        applied ? "opacity-60 hover:opacity-100" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
        >
          {showCompanyLogo && (
            <RowLogo
              domain={companyDomain}
              displayName={m.companyDisplayName}
            />
          )}
          <span
            className={`inline-flex w-12 shrink-0 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${LEVEL_PILL[m.level]}`}
          >
            {LEVEL_LABEL[m.level]}
          </span>
          {fitScore != null && (
            <span
              title={m.fitSummary ?? `Fit score: ${fitScore.toFixed(1)}`}
              className={`inline-flex shrink-0 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ring-1 ring-inset ${fitBadgeClass(fitScore)}`}
            >
              {fitScore.toFixed(1)}
            </span>
          )}
          {isStale && (
            <span
              title={`First seen >${STALE_DAYS} days ago — likely stale or hard-to-fill`}
              className="inline-flex shrink-0 justify-center rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700 ring-1 ring-inset ring-red-200/70 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-400/20"
            >
              Stale
            </span>
          )}
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg group-hover:text-fg hover:overflow-visible">
            <span className="hover:relative hover:z-10 hover:-mx-1 hover:rounded hover:bg-surface hover:px-1 hover:shadow-sm">
              {m.title}
            </span>
          </h3>
          <span className="hidden max-w-[180px] truncate text-xs text-fg-subtle sm:block md:max-w-[280px]">
            {m.location}
          </span>
        </a>
        {isDemo && m.level !== "LOW" && (
          <span
            title={DEMO_TOOLTIP}
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-medium text-fg-faint opacity-60 sm:h-auto sm:px-1.5 sm:py-1"
            aria-label="AI analysis disabled in demo mode"
          >
            <span>AI</span>
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 4.5 L6 7.5 L9 4.5" />
            </svg>
          </span>
        )}
        {canSummarize && (
          <button
            type="button"
            aria-label={isSummaryOpen ? "Hide AI analysis" : "View AI analysis"}
            aria-expanded={isSummaryOpen}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSummary(m.id);
            }}
            className="inline-flex h-9 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-medium text-fg-subtle transition-colors hover:bg-muted hover:text-fg sm:h-auto sm:px-1.5 sm:py-1"
          >
            <span>AI</span>
            <svg
              className={`h-3 w-3 transition-transform ${isSummaryOpen ? "rotate-180" : ""}`}
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 4.5 L6 7.5 L9 4.5" />
            </svg>
          </button>
        )}
        {/* Apply toggle: tap-target wrapper expands the hit-area on
            mobile while the visible track stays compact. The flex
            wrapper picks up the click on whitespace around the small
            switch graphic. */}
        <button
          type="button"
          role="switch"
          aria-checked={applied}
          aria-label={
            isDemo
              ? "Apply toggle disabled in demo mode"
              : applied
                ? "Mark not applied"
                : "Mark applied"
          }
          onClick={isDemo ? (e) => { e.preventDefault(); e.stopPropagation(); } : onToggle}
          disabled={pending || isDemo}
          title={isDemo ? DEMO_TOOLTIP : undefined}
          className="inline-flex h-9 shrink-0 items-center justify-center px-1 disabled:cursor-not-allowed sm:h-auto sm:px-0"
        >
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors sm:h-4 sm:w-7 ${
              isDemo
                ? "bg-line opacity-50"
                : applied
                  ? "bg-emerald-500"
                  : "bg-line group-hover:bg-line-strong"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform sm:h-3 sm:w-3 ${
                applied && !isDemo ? "translate-x-[18px] sm:translate-x-3.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
        <button
          type="button"
          aria-label={isDemo ? "Dismiss disabled in demo mode" : "Dismiss this role"}
          onClick={isDemo ? (e) => { e.preventDefault(); e.stopPropagation(); } : onDismissClick}
          disabled={pending || isDemo}
          title={isDemo ? DEMO_TOOLTIP : undefined}
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-fg-faint transition-colors disabled:cursor-not-allowed sm:h-4 sm:w-4 ${
            isDemo
              ? "opacity-40"
              : "hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 disabled:cursor-wait"
          }`}
        >
          <svg
            className="h-3 w-3 sm:h-2.5 sm:w-2.5"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 2 L8 8 M8 2 L2 8" />
          </svg>
        </button>
        <time className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-fg-subtle sm:w-16 sm:text-[11px]">
          {timeAgo(m.firstSeen)}
        </time>
      </div>
      {isSummaryOpen && canSummarize && (
        <SummarySection
          loading={summaryLoading}
          error={summaryError}
          data={summaryData}
          onRegenerate={onRegenerate}
        />
      )}
    </div>
  );
}

// Inline logo used by the flat score-sort row layout. Mirrors
// CompanyHeader's CompanyLogo but at row scale (20px) and without the
// state machine — the favicon URL just renders, and the tiny letter
// circle picks up if `unoptimized` Image errors. For the score-sort
// view there's no error-state setState here because each row is its
// own component instance and the few logo 404s don't justify the
// state plumbing across hundreds of memoized rows.
function RowLogo({ domain, displayName }: { domain?: string; displayName: string }) {
  if (!domain) {
    return (
      <div
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-fg-muted"
        title={displayName}
      >
        {displayName.charAt(0)}
      </div>
    );
  }
  return (
    <Image
      src={logoUrl(domain)}
      alt=""
      width={20}
      height={20}
      title={displayName}
      className="h-5 w-5 shrink-0 rounded object-contain"
      unoptimized
    />
  );
}

// Default React.memo shallow-compare is enough here: m comes from the
// parent's matches array (stable reference until the underlying data
// changes), isSummaryOpen/viewerRole are primitives, and
// onToggleSummary is now wrapped in useCallback by the parent.
const MatchCard = memo(MatchCardImpl);
export default MatchCard;

function SummarySection({
  loading,
  error,
  data,
  onRegenerate,
}: {
  loading: boolean;
  error: string | null;
  data: SummaryData | null;
  onRegenerate: () => void;
}) {
  return (
    <div className="border-t border-line-subtle bg-muted px-4 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
        AI Analysis
      </div>
      {loading && !data && <SummarySkeleton />}
      {error && !loading && (
        <div className="flex items-start justify-between gap-3 text-xs">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-rose-600 dark:text-rose-400">
              Couldn&apos;t generate analysis
            </span>
            <span className="break-words font-mono text-[10px] text-fg-subtle">
              {error}
            </span>
          </div>
          <button
            type="button"
            onClick={onRegenerate}
            className="shrink-0 rounded border border-line bg-surface px-2 py-0.5 text-fg-muted hover:border-line-strong hover:text-fg"
          >
            Regenerate
          </button>
        </div>
      )}
      {data && !loading && (
        <div className="flex flex-col gap-4 text-sm text-fg-muted">
          <p className="leading-relaxed">{data.summary}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="border-l-2 border-emerald-500 pl-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Why you fit
              </div>
              <ul className="flex flex-col gap-1.5">
                {data.pros.map((p, i) => (
                  <li key={i} className="text-[13px] leading-snug text-fg-muted">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-l-2 border-amber-500 pl-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Why you might not
              </div>
              <ul className="flex flex-col gap-1.5">
                {data.cons.map((c, i) => (
                  <li key={i} className="text-[13px] leading-snug text-fg-muted">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px] text-fg-subtle">
            <span className="font-mono">Generated {timeAgo(new Date(data.generated_at))}</span>
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded border border-line bg-surface px-2 py-0.5 text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              Regenerate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      <div className="h-3 w-full rounded bg-line"></div>
      <div className="h-3 w-5/6 rounded bg-line"></div>
      <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
        <div className="h-12 rounded bg-line"></div>
        <div className="h-12 rounded bg-line"></div>
      </div>
    </div>
  );
}
