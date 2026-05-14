import type { Match } from "@/db/schema";
import type { Level } from "@/lib/scan/types";

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

function fitBadgeClass(score: number): string {
  if (score >= 8.0) return "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20";
  if (score >= 6.0) return "bg-amber-50 text-amber-700 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20";
  return "bg-stone-100 text-stone-500 ring-stone-200 dark:bg-stone-800/60 dark:text-stone-400 dark:ring-stone-700";
}

function shortAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

// Read-only condensed row used by the /analytics recent-dismissals
// list. Same visual rhythm as MatchCard but no interactive controls.
// `timestamp` selects which date to display:
//   "first"     → m.firstSeen
//   "applied"   → m.appliedAt (fallback updatedAt)
//   "updated"   → m.updatedAt
//   "dismissed" → m.dismissedAt (fallback updatedAt)
export type CompactRowTimestamp = "first" | "applied" | "updated" | "dismissed";

export default function CompactRow({
  m,
  applyUrl,
  timestamp,
  muted,
}: {
  m: Match;
  applyUrl: string;
  timestamp: CompactRowTimestamp;
  muted?: boolean;
}) {
  const ts =
    timestamp === "applied"
      ? (m.appliedAt ?? m.updatedAt)
      : timestamp === "updated"
        ? m.updatedAt
        : timestamp === "dismissed"
          ? (m.dismissedAt ?? m.updatedAt)
          : m.firstSeen;
  const fitScore = m.fitScore != null ? parseFloat(m.fitScore) : null;
  return (
    <li>
      <a
        href={applyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`group surface-hover flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 ${
          muted ? "opacity-70" : ""
        }`}
      >
        <span
          className={`inline-flex w-12 shrink-0 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${LEVEL_PILL[m.level]}`}
        >
          {LEVEL_LABEL[m.level]}
        </span>
        {fitScore != null && (
          <span
            title={m.fitSummary ?? `Fit score: ${fitScore.toFixed(1)}`}
            className={`inline-flex shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ring-1 ring-inset ${fitBadgeClass(fitScore)}`}
          >
            {fitScore.toFixed(1)}
          </span>
        )}
        <span className="hidden w-32 shrink-0 truncate text-xs text-fg-subtle sm:inline">
          {m.companyDisplayName}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg-muted group-hover:text-fg">
          {m.title}
        </span>
        <time className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-subtle">
          {shortAgo(ts)}
        </time>
      </a>
    </li>
  );
}
