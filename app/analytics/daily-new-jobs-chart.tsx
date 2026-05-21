"use client";

import { useMemo, useState } from "react";
import type { Level } from "@/lib/scan/types";

// Daily / weekly new-jobs bar chart, parallel in structure to
// app/docs/daily-spend-chart.tsx. Each bar is stacked by level
// (BV / HIGH / MEDIUM / LOW), color-matched to TopCompaniesList +
// JobsByLevel. Level checkboxes toggle which segments contribute to
// the visible total + the y-axis scale.
//
// "New jobs" = matches.first_seen rows where is_baseline = false
// (intentional bulk imports excluded). See the server query in
// app/analytics/page.tsx.

export type DailyNewJobsRow = {
  date: string;
  counts: Record<Level, number>;
};

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

// Stack source order = visual bottom-to-top via flex-col-reverse:
// BV at bottom, LOW at top. Matches TopCompaniesList's left-to-right
// order so the color story is consistent across the page.
const STACK_ORDER: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];

const LEVEL_BAR_COLOR: Record<Level, string> = {
  BV: "bg-indigo-600 dark:bg-indigo-500",
  HIGH: "bg-rose-600 dark:bg-rose-500",
  MEDIUM: "bg-amber-500 dark:bg-amber-400",
  LOW: "bg-stone-400 dark:bg-stone-500",
};

const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};

const EMPTY_COUNTS: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

export function DailyNewJobsChart({ data }: { data: DailyNewJobsRow[] }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [units, setUnits] = useState<number>(DEFAULT_RANGE.day);
  const [enabled, setEnabled] = useState<Record<Level, boolean>>({
    BV: true,
    HIGH: true,
    MEDIUM: true,
    LOW: true,
  });

  const padded = useMemo(
    () =>
      granularity === "day"
        ? buildDailyRange(data, units)
        : buildWeeklyRange(data, units),
    [data, granularity, units],
  );

  const visibleTotal = (row: DailyNewJobsRow): number =>
    STACK_ORDER.reduce(
      (sum, l) => sum + (enabled[l] ? row.counts[l] : 0),
      0,
    );

  const total = padded.reduce((sum, d) => sum + visibleTotal(d), 0);
  const avg = padded.length > 0 ? total / padded.length : 0;
  const maxCount = Math.max(...padded.map(visibleTotal), 0);
  const yMax = niceUpper(maxCount);
  const avgFromTopPct =
    yMax > 0 ? Math.min(99, Math.max(1, 100 - (avg / yMax) * 100)) : 100;

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

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          Show
        </span>
        {STACK_ORDER.map((l) => (
          <label
            key={l}
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted hover:text-fg"
          >
            <input
              type="checkbox"
              checked={enabled[l]}
              onChange={(e) =>
                setEnabled((prev) => ({ ...prev, [l]: e.target.checked }))
              }
              className="h-3 w-3 cursor-pointer accent-fg"
            />
            <span
              className={`inline-block h-2 w-2 rounded-sm ${LEVEL_BAR_COLOR[l]}`}
            />
            <span className="font-mono tabular-nums">{LEVEL_LABEL[l]}</span>
          </label>
        ))}
      </div>

      <div className="relative">
        <div className="relative flex h-[9.2rem] items-end gap-[1px] border-b border-l border-line pl-2 pr-1 pt-1">
          {padded.map((d) => {
            const vTotal = visibleTotal(d);
            return (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 items-end"
                title={tooltipFor(d, granularity, vTotal)}
              >
                {vTotal === 0 ? (
                  <div
                    className="w-full rounded-sm bg-muted transition-colors group-hover:bg-line"
                    style={{ height: "1%" }}
                  />
                ) : (
                  <div className="flex w-full flex-col-reverse overflow-hidden rounded-sm">
                    {STACK_ORDER.map((level) => {
                      if (!enabled[level]) return null;
                      const c = d.counts[level];
                      if (c === 0) return null;
                      const heightPct = yMax === 0 ? 0 : (c / yMax) * 100;
                      return (
                        <div
                          key={level}
                          className={`w-full transition-opacity ${LEVEL_BAR_COLOR[level]} group-hover:opacity-80`}
                          style={{ height: `${heightPct}%` }}
                        />
                      );
                    })}
                  </div>
                )}
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
  const map = new Map(data.map((d) => [d.date, d.counts]));
  const out: DailyNewJobsRow[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, counts: map.get(iso) ?? { ...EMPTY_COUNTS } });
  }
  return out;
}

function buildWeeklyRange(data: DailyNewJobsRow[], weeks: number): DailyNewJobsRow[] {
  const dailyMap = new Map(data.map((d) => [d.date, d.counts]));
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
    const sum: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart);
      day.setUTCDate(day.getUTCDate() + d);
      const iso = day.toISOString().slice(0, 10);
      const c = dailyMap.get(iso);
      if (c) {
        sum.BV += c.BV;
        sum.HIGH += c.HIGH;
        sum.MEDIUM += c.MEDIUM;
        sum.LOW += c.LOW;
      }
    }
    out.push({ date: weekStart.toISOString().slice(0, 10), counts: sum });
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

function tooltipFor(
  d: DailyNewJobsRow,
  granularity: Granularity,
  visibleTotal: number,
): string {
  const label = labelForBar(d.date, granularity);
  const parts = STACK_ORDER.map((l) => `${LEVEL_LABEL[l]} ${d.counts[l]}`).join(" · ");
  return `${label} — ${parts} — total ${visibleTotal}`;
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
