"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Match, DismissReason } from "@/db/schema";
import type { Level } from "@/lib/scan/types";

// Apply URL is pre-computed server-side (in page.tsx / all/page.tsx)
// and threaded onto each row. Keeps the client bundle free of
// @/lib/scan/urls → @/lib/scan/workday-config → @/lib/config/load,
// which pulls node:fs.
export type MatchWithUrl = Match & { applyUrl: string };

type SummaryData = {
  summary: string;
  pros: string[];
  cons: string[];
  cached: boolean;
  generated_at: string;
};

const LEVEL_PILL: Record<Level, string> = {
  BV: "bg-indigo-50 text-indigo-700 ring-indigo-200/70",
  HIGH: "bg-rose-50 text-rose-700 ring-rose-200/70",
  MEDIUM: "bg-amber-50 text-amber-800 ring-amber-200/70",
  LOW: "bg-stone-100 text-stone-600 ring-stone-200",
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
  if (score >= 8.0) return "bg-emerald-50 text-emerald-700 ring-emerald-200/70";
  if (score >= 6.0) return "bg-amber-50 text-amber-700 ring-amber-200/70";
  return "bg-stone-100 text-stone-500 ring-stone-200";
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
      <span className={selected ? "text-stone-900" : "text-stone-600"}>{label}</span>
    </label>
  );
}

export default function MatchCard({
  m,
  isSummaryOpen,
  onToggleSummary,
}: {
  m: MatchWithUrl;
  isSummaryOpen: boolean;
  onToggleSummary: () => void;
}) {
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

  const canSummarize = m.level !== "LOW";

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
      <div className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_1px_rgba(0,0,0,0.06)]">
        <span className="shrink-0 text-xs font-medium text-stone-700">Wrong:</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
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
          className="shrink-0 rounded bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-200 disabled:cursor-wait"
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
      className={`group rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_1px_1px_rgba(0,0,0,0.06)] transition-all hover:border-stone-300 hover:shadow-[0_2px_6px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.08)] ${
        applied ? "opacity-60 hover:opacity-100" : ""
      } ${!isSummaryOpen ? "hover:-translate-y-px" : ""}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-3"
        >
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
              className="inline-flex shrink-0 justify-center rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700 ring-1 ring-inset ring-red-200/70"
            >
              Stale
            </span>
          )}
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900 group-hover:text-stone-950 hover:overflow-visible">
            <span className="hover:relative hover:z-10 hover:-mx-1 hover:rounded hover:bg-white hover:px-1 hover:shadow-sm">
              {m.title}
            </span>
          </h3>
          <span className="hidden max-w-[180px] truncate text-xs text-stone-500 sm:block md:max-w-[280px]">
            {m.location}
          </span>
        </a>
        {canSummarize && (
          <button
            type="button"
            aria-label={isSummaryOpen ? "Hide AI analysis" : "View AI analysis"}
            aria-expanded={isSummaryOpen}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSummary();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800"
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
        <button
          type="button"
          role="switch"
          aria-checked={applied}
          aria-label={applied ? "Mark not applied" : "Mark applied"}
          onClick={onToggle}
          disabled={pending}
          className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:cursor-wait ${
            applied ? "bg-emerald-500" : "bg-stone-200 hover:bg-stone-300"
          }`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${
              applied ? "translate-x-3.5" : "translate-x-0.5"
            }`}
          />
        </button>
        <button
          type="button"
          aria-label="Dismiss this role"
          onClick={onDismissClick}
          disabled={pending}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-stone-300 transition-colors hover:bg-rose-50 hover:text-rose-500 disabled:cursor-wait"
        >
          <svg
            className="h-2.5 w-2.5"
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
        <time className="w-16 shrink-0 text-right text-xs tabular-nums text-stone-400">
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
    <div className="border-t border-stone-100 bg-stone-50/50 px-4 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
        AI Analysis
      </div>
      {loading && !data && <SummarySkeleton />}
      {error && !loading && (
        <div className="flex items-start justify-between gap-3 text-xs">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-rose-600">
              Couldn&apos;t generate analysis
            </span>
            <span className="break-words font-mono text-[10px] text-stone-400">
              {error}
            </span>
          </div>
          <button
            type="button"
            onClick={onRegenerate}
            className="shrink-0 rounded border border-stone-200 bg-white px-2 py-0.5 text-stone-600 hover:border-stone-300 hover:text-stone-900"
          >
            Regenerate
          </button>
        </div>
      )}
      {data && !loading && (
        <div className="flex flex-col gap-4 text-sm text-stone-700">
          <p className="leading-relaxed">{data.summary}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="border-l-2 border-emerald-500 pl-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
                Why you fit
              </div>
              <ul className="flex flex-col gap-1.5">
                {data.pros.map((p, i) => (
                  <li key={i} className="text-[13px] leading-snug text-stone-700">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-l-2 border-amber-500 pl-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
                Why you might not
              </div>
              <ul className="flex flex-col gap-1.5">
                {data.cons.map((c, i) => (
                  <li key={i} className="text-[13px] leading-snug text-stone-700">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px] text-stone-400">
            <span>Generated {timeAgo(new Date(data.generated_at))}</span>
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded border border-stone-200 bg-white px-2 py-0.5 text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-800"
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
      <div className="h-3 w-full rounded bg-stone-200/80"></div>
      <div className="h-3 w-5/6 rounded bg-stone-200/80"></div>
      <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
        <div className="h-12 rounded bg-stone-200/60"></div>
        <div className="h-12 rounded bg-stone-200/60"></div>
      </div>
    </div>
  );
}
