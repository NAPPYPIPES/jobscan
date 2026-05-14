"use client";

import { useMemo, useState } from "react";

// Daily API spend bar chart with range selector. Receives the full
// 90-day window from the server component as a sparse array (only
// days with calls are present), pads zero-spend days into the
// selected range, and renders pure-CSS bars. No chart library — for
// ~14-90 vertical divs the cost of importing Recharts isn't worth it.

export type DailySpendRow = { date: string; spendUsd: number };

const RANGES = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const;

type RangeDays = (typeof RANGES)[number]["days"];

export function DailySpendChart({ data }: { data: DailySpendRow[] }) {
  const [rangeDays, setRangeDays] = useState<RangeDays>(14);

  const padded = useMemo(() => buildRange(data, rangeDays), [data, rangeDays]);

  const total = padded.reduce((sum, d) => sum + d.spendUsd, 0);
  const maxSpend = Math.max(...padded.map((d) => d.spendUsd), 0);
  const yMax = niceUpper(maxSpend);

  const labelEvery = Math.max(1, Math.ceil(rangeDays / 7));

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            Daily spend
          </h3>
          <p className="mt-0.5 text-xs text-stone-400">
            <span className="font-mono tabular-nums text-stone-700">
              ${total.toFixed(2)}
            </span>{" "}
            in last {rangeDays} days
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-stone-200 bg-stone-50 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setRangeDays(r.days)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
                rangeDays === r.days
                  ? "bg-white text-stone-900 shadow-sm"
                  : "text-stone-500 hover:text-stone-700"
              }`}
            >
              {r.label}
            </button>
          ))}
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
                title={`${shortDate(d.date)} — $${d.spendUsd.toFixed(4)}`}
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
            {i % labelEvery === 0 || i === padded.length - 1 ? shortDate(d.date) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildRange(data: DailySpendRow[], days: number): DailySpendRow[] {
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

function niceUpper(max: number): number {
  if (max <= 0) return 0.1;
  const buckets = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 50, 100];
  for (const b of buckets) if (max <= b) return b;
  return Math.ceil(max / 50) * 50;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
