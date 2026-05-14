import Link from "next/link";
import type { Level } from "@/lib/scan/types";

const LEVELS: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];
const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};
const LEVEL_PILL: Record<Level, string> = {
  BV: "bg-indigo-50 text-indigo-700 ring-indigo-200/70 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-400/20",
  HIGH: "bg-rose-50 text-rose-700 ring-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20",
  MEDIUM: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20",
  LOW: "bg-stone-100 text-stone-600 ring-stone-200 dark:bg-stone-800/60 dark:text-stone-300 dark:ring-stone-700",
};
const LEVEL_BAR: Record<Level, string> = {
  BV: "bg-indigo-600 dark:bg-indigo-500",
  HIGH: "bg-rose-600 dark:bg-rose-500",
  MEDIUM: "bg-amber-500 dark:bg-amber-400",
  LOW: "bg-stone-400 dark:bg-stone-500",
};

// Trio of "new roles" widgets, all reading from the same 72h slice of
// matches but bucketing differently. Server-rendered; the page does
// the SQL pass and threads results down as props.
export type NewRolesByLevel = Record<Level, { h24: number; h48: number; h72: number }>;

export function JobsByLevel({ data }: { data: NewRolesByLevel }) {
  const max = Math.max(
    ...LEVELS.flatMap((l) => [data[l].h24, data[l].h48, data[l].h72]),
    1,
  );

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        New roles by level
      </h3>
      <p className="mb-3 text-[11px] text-fg-subtle">
        Net-new postings (excludes baseline + dismissed).
      </p>
      <div className="mb-2 grid grid-cols-[3.5rem_1fr_2rem_2rem_2rem] items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle">
        <span />
        <span />
        <span className="text-right font-mono tabular-nums">24h</span>
        <span className="text-right font-mono tabular-nums">48h</span>
        <span className="text-right font-mono tabular-nums">72h</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {LEVELS.map((l) => {
          const { h24, h48, h72 } = data[l];
          const widthPct = (h72 / max) * 100;
          return (
            <li
              key={l}
              className="grid grid-cols-[3.5rem_1fr_2rem_2rem_2rem] items-center gap-2"
            >
              <Link
                href={`/all?levels=${l}`}
                className={`inline-flex w-12 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset transition-opacity hover:opacity-80 ${LEVEL_PILL[l]}`}
                title={`See all ${LEVEL_LABEL[l]} roles`}
              >
                {LEVEL_LABEL[l]}
              </Link>
              <div className="h-2.5 w-full overflow-hidden rounded-sm bg-muted">
                {h72 > 0 && (
                  <div
                    className={`h-full ${LEVEL_BAR[l]}`}
                    style={{ width: `${Math.max(widthPct, 4)}%` }}
                  />
                )}
              </div>
              <span className="text-right font-mono text-xs font-semibold tabular-nums text-fg">
                {h24}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-fg-muted">
                {h48}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-fg-subtle">
                {h72}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type NewRolesByFitBand = {
  high: number; // >= 8.0
  good: number; // 6.0 - 7.9
  low: number; // < 6.0
  unscored: number; // fit_score is null
};

export function JobsByFit({ data }: { data: NewRolesByFitBand }) {
  const total = data.high + data.good + data.low + data.unscored;
  const bands: { key: keyof NewRolesByFitBand; label: string; bar: string; pill: string }[] = [
    {
      key: "high",
      label: "≥ 8.0",
      bar: "bg-emerald-500 dark:bg-emerald-400",
      pill: "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20",
    },
    {
      key: "good",
      label: "6.0 – 7.9",
      bar: "bg-amber-500 dark:bg-amber-400",
      pill: "bg-amber-50 text-amber-700 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20",
    },
    {
      key: "low",
      label: "< 6.0",
      bar: "bg-stone-400 dark:bg-stone-500",
      pill: "bg-stone-100 text-stone-600 ring-stone-200 dark:bg-stone-800/60 dark:text-stone-300 dark:ring-stone-700",
    },
    {
      key: "unscored",
      label: "Unscored",
      bar: "bg-stone-200 dark:bg-stone-700",
      pill: "bg-muted text-fg-subtle ring-line",
    },
  ];
  const max = Math.max(...bands.map((b) => data[b.key]), 1);

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        New roles by fit (24h)
      </h3>
      <p className="mb-3 text-[11px] text-fg-subtle">
        <span className="font-mono tabular-nums text-fg">{total}</span> posted in last 24h · <span className="font-mono tabular-nums text-fg">{data.high + data.good}</span> above alert threshold.
      </p>
      <ul className="flex flex-col gap-1.5">
        {bands.map((b) => {
          const v = data[b.key];
          const pct = (v / max) * 100;
          return (
            <li
              key={b.key}
              className="grid grid-cols-[5rem_1fr_2rem] items-center gap-2"
            >
              <span
                className={`inline-flex justify-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ring-1 ring-inset ${b.pill}`}
                title={b.label}
              >
                {b.label}
              </span>
              <div className="h-2.5 w-full overflow-hidden rounded-sm bg-muted">
                {v > 0 && (
                  <div
                    className={`h-full ${b.bar}`}
                    style={{ width: `${Math.max(pct, 4)}%` }}
                  />
                )}
              </div>
              <span className="text-right font-mono text-xs font-semibold tabular-nums text-fg">
                {v}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type NewRolesByCompany = {
  slug: string;
  name: string;
  h24: number;
  h48: number;
  h72: number;
};

export function JobsByCompany({ rows }: { rows: NewRolesByCompany[] }) {
  // Sort by 24h, fall back to 48h, then 72h. Keep companies with zero
  // 24h activity but real 48h/72h so the user still sees them.
  const sorted = [...rows]
    .sort((a, b) => b.h24 - a.h24 || b.h48 - a.h48 || b.h72 - a.h72)
    .slice(0, 10);

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        New roles by company
      </h3>
      <p className="mb-3 text-[11px] text-fg-subtle">
        Top 10 by 24h count. Click company to drill into /all.
      </p>
      {sorted.length === 0 ? (
        <p className="py-2 text-xs text-fg-subtle">
          No new postings in the last 72 hours.
        </p>
      ) : (
        <>
          <div className="mb-1 grid grid-cols-[1.25rem_1fr_2rem_2rem_2rem] items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle">
            <span />
            <span />
            <span className="text-right font-mono tabular-nums">24h</span>
            <span className="text-right font-mono tabular-nums">48h</span>
            <span className="text-right font-mono tabular-nums">72h</span>
          </div>
          <ul className="flex flex-col">
            {sorted.map((r, i) => (
              <li
                key={r.slug}
                className={`grid grid-cols-[1.25rem_1fr_2rem_2rem_2rem] items-center gap-2 py-1.5 ${
                  i > 0 ? "border-t border-line-subtle" : ""
                }`}
              >
                <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                  {i + 1}
                </span>
                <Link
                  href={`/all?company=${encodeURIComponent(r.slug)}`}
                  className="truncate text-sm text-fg hover:underline"
                  title={r.name}
                >
                  {r.name}
                </Link>
                <span className="text-right font-mono text-xs font-semibold tabular-nums text-fg">
                  {r.h24}
                </span>
                <span className="text-right font-mono text-xs tabular-nums text-fg-muted">
                  {r.h48}
                </span>
                <span className="text-right font-mono text-xs tabular-nums text-fg-subtle">
                  {r.h72}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
