"use client";

import { useMemo, useState } from "react";

// API spend bar chart with granularity (day / week) and range
// selectors. Receives raw daily rows from the server (only days with
// calls are present); the client component pads zero-spend gaps,
// optionally aggregates to weekly buckets, and renders pure-CSS bars.
// No chart library — for ~12-90 vertical divs the cost of importing
// Recharts isn't worth it.

export type DailySpendRow = { date: string; spendUsd: number };

type Granularity = "day" | "week";

const RANGES: Record<Granularity, readonly { units: number; label: string }[]> = {
  day: [
    { units: 7, label: "7d" },
    { units: 14, label: "14d" },
    { units: 30, label: "30d" },
    { units: 90, label: "90d" },
  ],
  week: [
    { units: 4, label: "4w" },
    { units: 8, label: "8w" },
    { units: 12, label: "12w" },
  ],
};

const DEFAULT_RANGE: Record<Granularity, number> = { day: 14, week: 8 };

export function DailySpendChart({ data }: { data: DailySpendRow[] }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [units, setUnits] = useState<number>(DEFAULT_RANGE.day);
  const [excludeOutliers, setExcludeOutliers] = useState(false);

  const padded = useMemo(
    () =>
      granularity === "day"
        ? buildDailyRange(data, units)
        : buildWeeklyRange(data, units),
    [data, granularity, units],
  );

  // Tukey fence (Q3 + 1.5×IQR) over the non-zero buckets — zero days
  // are padding/idle, and including them would drag the quartiles to
  // 0 and flag every normal day. Infinity = nothing excluded.
  const outlierCutoff = useMemo(() => {
    if (!excludeOutliers) return Number.POSITIVE_INFINITY;
    return tukeyUpperFence(padded.map((d) => d.spendUsd));
  }, [padded, excludeOutliers]);

  const kept = padded.filter((d) => d.spendUsd <= outlierCutoff);
  const outlierCount = padded.length - kept.length;
  const total = kept.reduce((sum, d) => sum + d.spendUsd, 0);
  const avg = kept.length > 0 ? total / kept.length : 0;
  const maxSpend = Math.max(...kept.map((d) => d.spendUsd), 0);
  const yMax = niceUpper(maxSpend);
  // Position the avg line as % from the TOP of the chart (0 = top, 100 = bottom).
  // Clamp so the line doesn't sit exactly on the baseline (where it'd be
  // hidden by the border) and doesn't clip above the top.
  const avgFromTopPct = yMax > 0 ? Math.min(99, Math.max(1, 100 - (avg / yMax) * 100)) : 100;

  const labelEvery = Math.max(1, Math.ceil(padded.length / 7));
  const unitLabel = granularity === "day" ? "days" : "weeks";

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {granularity === "day" ? "Daily spend" : "Weekly spend"}
          </h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            <span className="font-mono tabular-nums text-fg">
              ${total.toFixed(2)}
            </span>{" "}
            in last {units} {unitLabel}
            <span className="mx-1.5 text-fg-faint">·</span>
            avg{" "}
            <span className="font-mono tabular-nums text-fg">
              ${avg.toFixed(2)}
            </span>{" "}
            / {granularity === "day" ? "day" : "week"}
            {excludeOutliers && outlierCount > 0 && (
              <>
                <span className="mx-1.5 text-fg-faint">·</span>
                <span className="text-amber-700 dark:text-amber-400">
                  {outlierCount} outlier{outlierCount === 1 ? "" : "s"} excluded
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 rounded-md border border-line bg-muted p-0.5">
            {(["day", "week"] as Granularity[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => {
                  setGranularity(g);
                  setUnits(DEFAULT_RANGE[g]);
                }}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  granularity === g
                    ? "bg-surface text-fg shadow-sm"
                    : "text-fg-subtle hover:text-fg"
                }`}
              >
                {g === "day" ? "Day" : "Week"}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-md border border-line bg-muted p-0.5">
            {RANGES[granularity].map((r) => (
              <button
                key={r.units}
                type="button"
                onClick={() => setUnits(r.units)}
                className={`rounded px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums transition-colors ${
                  units === r.units
                    ? "bg-surface text-fg shadow-sm"
                    : "text-fg-subtle hover:text-fg"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label
            className="flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-line bg-muted px-2 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:text-fg"
            title="Hide spend spikes (above Q3 + 1.5×IQR of non-zero buckets) from the chart scale and totals"
          >
            <input
              type="checkbox"
              checked={excludeOutliers}
              onChange={(e) => setExcludeOutliers(e.target.checked)}
              className="h-3 w-3 accent-emerald-600"
            />
            Remove outliers
          </label>
        </div>
      </div>

      <div className="relative">
        <div className="relative flex h-32 items-end gap-[1px] border-b border-l border-line pl-2 pr-1 pt-1">
          {padded.map((d) => {
            const isOutlier = d.spendUsd > outlierCutoff;
            // Outliers stay visible but clip at the (rescaled) top in
            // amber, so the spike's existence isn't hidden — only its
            // distortion of the y-axis.
            const heightPct =
              yMax === 0 ? 0 : (Math.min(d.spendUsd, yMax) / yMax) * 100;
            return (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 items-end"
                title={`${labelForBar(d.date, granularity)} — $${d.spendUsd.toFixed(4)}${
                  isOutlier ? " (outlier, clipped)" : ""
                }`}
              >
                <div
                  className={`w-full rounded-sm transition-colors ${
                    isOutlier
                      ? "bg-amber-400 group-hover:bg-amber-500 dark:bg-amber-500 dark:group-hover:bg-amber-400"
                      : d.spendUsd > 0
                        ? "bg-emerald-500 group-hover:bg-emerald-600 dark:bg-emerald-400 dark:group-hover:bg-emerald-300"
                        : "bg-muted group-hover:bg-line"
                  }`}
                  style={{ height: `${Math.max(heightPct, d.spendUsd > 0 ? 2 : 1)}%` }}
                />
              </div>
            );
          })}
          {avg > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-subtle/60"
              style={{ top: `${avgFromTopPct}%` }}
              title={`Avg $${avg.toFixed(4)} per ${granularity === "day" ? "day" : "week"}`}
            />
          )}
        </div>
        <div className="pointer-events-none absolute right-1 top-0 font-mono text-[10px] tabular-nums text-fg-subtle">
          ${yMax.toFixed(2)}
        </div>
      </div>

      <div className="mt-1 flex gap-[1px] pl-2 pr-1 font-mono text-[10px] tabular-nums text-fg-subtle">
        {padded.map((d, i) => (
          <div key={d.date} className="flex flex-1 justify-center">
            {i % labelEvery === 0 || i === padded.length - 1
              ? labelForAxis(d.date, granularity)
              : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildDailyRange(data: DailySpendRow[], days: number): DailySpendRow[] {
  const map = new Map(data.map((d) => [d.date, d.spendUsd]));
  const out: DailySpendRow[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, spendUsd: map.get(iso) ?? 0 });
  }
  return out;
}

// Bucket daily rows into ISO weeks (Mon-Sun) ending at the current
// UTC week. Each bucket's `date` is its Monday in YYYY-MM-DD; tooltips
// resolve that to "Mar 11 – Mar 17".
function buildWeeklyRange(data: DailySpendRow[], weeks: number): DailySpendRow[] {
  const dailyMap = new Map(data.map((d) => [d.date, d.spendUsd]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // Most recent Monday on/before today (UTC). getUTCDay: 0=Sun, 1=Mon.
  const dow = today.getUTCDay();
  const offsetToMonday = (dow + 6) % 7;
  const currentWeekStart = new Date(today);
  currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - offsetToMonday);

  const out: DailySpendRow[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - w * 7);
    let sum = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart);
      day.setUTCDate(day.getUTCDate() + d);
      const iso = day.toISOString().slice(0, 10);
      sum += dailyMap.get(iso) ?? 0;
    }
    out.push({ date: weekStart.toISOString().slice(0, 10), spendUsd: sum });
  }
  return out;
}

// Upper Tukey fence (Q3 + 1.5×IQR) over the non-zero values, with
// linear-interpolated quartiles. Returns Infinity when there are too
// few points to call anything an outlier (< 4 non-zero buckets) or
// when nothing actually exceeds the fence.
function tukeyUpperFence(values: number[]): number {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nonzero.length < 4) return Number.POSITIVE_INFINITY;
  const quantile = (p: number) => {
    const idx = (nonzero.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return nonzero[lo] + (nonzero[hi] - nonzero[lo]) * (idx - lo);
  };
  const q1 = quantile(0.25);
  const q3 = quantile(0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  return nonzero.some((v) => v > fence) ? fence : Number.POSITIVE_INFINITY;
}

function niceUpper(max: number): number {
  if (max <= 0) return 0.1;
  const buckets = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 50, 100];
  for (const b of buckets) if (max <= b) return b;
  return Math.ceil(max / 50) * 50;
}

function labelForBar(iso: string, granularity: Granularity): string {
  if (granularity === "day") return shortDate(iso);
  const start = new Date(iso + "T00:00:00Z");
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${shortDate(iso)} – ${shortDate(end.toISOString().slice(0, 10))}`;
}

function labelForAxis(iso: string, granularity: Granularity): string {
  if (granularity === "day") return shortDate(iso);
  // Weekly axis shows just the start-of-week date — keeps it short.
  return shortDate(iso);
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
