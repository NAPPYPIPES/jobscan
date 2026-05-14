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

  const padded = useMemo(
    () =>
      granularity === "day"
        ? buildDailyRange(data, units)
        : buildWeeklyRange(data, units),
    [data, granularity, units],
  );

  const total = padded.reduce((sum, d) => sum + d.spendUsd, 0);
  const maxSpend = Math.max(...padded.map((d) => d.spendUsd), 0);
  const yMax = niceUpper(maxSpend);

  const labelEvery = Math.max(1, Math.ceil(padded.length / 7));
  const unitLabel = granularity === "day" ? "days" : "weeks";

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            {granularity === "day" ? "Daily spend" : "Weekly spend"}
          </h3>
          <p className="mt-0.5 text-xs text-stone-400">
            <span className="font-mono tabular-nums text-stone-700">
              ${total.toFixed(2)}
            </span>{" "}
            in last {units} {unitLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 rounded-md border border-stone-200 bg-stone-50 p-0.5">
            {(["day", "week"] as Granularity[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => {
                  setGranularity(g);
                  setUnits(DEFAULT_RANGE[g]);
                }}
                className={`rounded px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
                  granularity === g
                    ? "bg-white text-stone-900 shadow-sm"
                    : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {g === "day" ? "Day" : "Week"}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-md border border-stone-200 bg-stone-50 p-0.5">
            {RANGES[granularity].map((r) => (
              <button
                key={r.units}
                type="button"
                onClick={() => setUnits(r.units)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
                  units === r.units
                    ? "bg-white text-stone-900 shadow-sm"
                    : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="flex h-32 items-end gap-[1px] border-b border-l border-stone-200 pl-2 pr-1 pt-1">
          {padded.map((d) => {
            const heightPct = yMax === 0 ? 0 : (d.spendUsd / yMax) * 100;
            return (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 items-end"
                title={`${labelForBar(d.date, granularity)} — $${d.spendUsd.toFixed(4)}`}
              >
                <div
                  className={`w-full rounded-sm transition-colors ${
                    d.spendUsd > 0
                      ? "bg-emerald-500 group-hover:bg-emerald-600"
                      : "bg-stone-100 group-hover:bg-stone-200"
                  }`}
                  style={{ height: `${Math.max(heightPct, d.spendUsd > 0 ? 2 : 1)}%` }}
                />
              </div>
            );
          })}
        </div>
        <div className="pointer-events-none absolute right-1 top-0 text-[10px] tabular-nums text-stone-400">
          ${yMax.toFixed(2)}
        </div>
      </div>

      <div className="mt-1 flex gap-[1px] pl-2 pr-1 text-[10px] tabular-nums text-stone-400">
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
