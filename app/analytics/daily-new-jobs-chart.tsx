"use client";

import { useMemo, useState } from "react";

// Daily / weekly new-jobs bar chart, parallel in structure to
// app/docs/daily-spend-chart.tsx. Receives raw daily rows (only days
// with arrivals are present); the client pads zero gaps, optionally
// aggregates to weekly buckets, and renders pure-CSS bars plus an
// average line.
//
// "New jobs" = matches.first_seen rows where is_baseline = false
// (intentional bulk imports excluded). See the server query in
// app/analytics/page.tsx.

export type DailyNewJobsRow = { date: string; count: number };

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

export function DailyNewJobsChart({ data }: { data: DailyNewJobsRow[] }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [units, setUnits] = useState<number>(DEFAULT_RANGE.day);

  const padded = useMemo(
    () =>
      granularity === "day"
        ? buildDailyRange(data, units)
        : buildWeeklyRange(data, units),
    [data, granularity, units],
  );

  const total = padded.reduce((sum, d) => sum + d.count, 0);
  const avg = padded.length > 0 ? total / padded.length : 0;
  const maxCount = Math.max(...padded.map((d) => d.count), 0);
  const yMax = niceUpper(maxCount);
  const avgFromTopPct = yMax > 0 ? Math.min(99, Math.max(1, 100 - (avg / yMax) * 100)) : 100;

  const labelEvery = Math.max(1, Math.ceil(padded.length / 7));
  const unitLabel = granularity === "day" ? "days" : "weeks";

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {granularity === "day" ? "Daily new jobs" : "Weekly new jobs"}
          </h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            <span className="font-mono tabular-nums text-fg">{total}</span>{" "}
            in last {units} {unitLabel}
            <span className="mx-1.5 text-fg-faint">·</span>
            avg{" "}
            <span className="font-mono tabular-nums text-fg">
              {avg.toFixed(1)}
            </span>{" "}
            / {granularity === "day" ? "day" : "week"}
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
        </div>
      </div>

      <div className="relative">
        <div className="relative flex h-32 items-end gap-[1px] border-b border-l border-line pl-2 pr-1 pt-1">
          {padded.map((d) => {
            const heightPct = yMax === 0 ? 0 : (d.count / yMax) * 100;
            return (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 items-end"
                title={`${labelForBar(d.date, granularity)} — ${d.count} job${d.count === 1 ? "" : "s"}`}
              >
                <div
                  className={`w-full rounded-sm transition-colors ${
                    d.count > 0
                      ? "bg-indigo-500 group-hover:bg-indigo-600 dark:bg-indigo-400 dark:group-hover:bg-indigo-300"
                      : "bg-muted group-hover:bg-line"
                  }`}
                  style={{ height: `${Math.max(heightPct, d.count > 0 ? 2 : 1)}%` }}
                />
              </div>
            );
          })}
          {avg > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-fg-subtle/60"
              style={{ top: `${avgFromTopPct}%` }}
              title={`Avg ${avg.toFixed(1)} per ${granularity === "day" ? "day" : "week"}`}
            />
          )}
        </div>
        <div className="pointer-events-none absolute right-1 top-0 font-mono text-[10px] tabular-nums text-fg-subtle">
          {yMax}
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

function buildDailyRange(data: DailyNewJobsRow[], days: number): DailyNewJobsRow[] {
  const map = new Map(data.map((d) => [d.date, d.count]));
  const out: DailyNewJobsRow[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, count: map.get(iso) ?? 0 });
  }
  return out;
}

function buildWeeklyRange(data: DailyNewJobsRow[], weeks: number): DailyNewJobsRow[] {
  const dailyMap = new Map(data.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay();
  const offsetToMonday = (dow + 6) % 7;
  const currentWeekStart = new Date(today);
  currentWeekStart.setUTCDate(currentWeekStart.getUTCDate() - offsetToMonday);

  const out: DailyNewJobsRow[] = [];
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
    out.push({ date: weekStart.toISOString().slice(0, 10), count: sum });
  }
  return out;
}

// "Nice" integer upper bound for a job-count axis. Pick the smallest
// bucket >= max so bars never reach the top edge and the avg-line
// label position is stable.
function niceUpper(max: number): number {
  if (max <= 0) return 5;
  const buckets = [5, 10, 25, 50, 100, 200, 400, 800, 1500, 3000];
  for (const b of buckets) if (max <= b) return b;
  return Math.ceil(max / 1000) * 1000;
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
