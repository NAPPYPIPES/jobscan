"use client";

import Link from "next/link";
import { useState } from "react";
import type { Level } from "@/lib/scan/types";

const LEVELS: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];
const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};
const LEVEL_BAR_COLOR: Record<Level, string> = {
  BV: "bg-indigo-600",
  HIGH: "bg-rose-600",
  MEDIUM: "bg-amber-500",
  LOW: "bg-stone-400",
};

type SortBy = "total" | "med+" | "high+";
const SORT_LABEL: Record<SortBy, string> = {
  total: "Total",
  "med+": "MED+",
  "high+": "HIGH+",
};

export type CompanyData = {
  name: string;
  slug: string;
  byLevel: Record<Level, number>;
};

type Props = { companies: CompanyData[] };

// Top 10 companies by open roles. Two independent controls:
//   - Legend toggles (which level segments are visible in bars + count)
//   - Sort selector (always uses full byLevel data, regardless of legend)
// Each segment + the company name are clickable links into /all with
// the matching company + level filters applied.
export default function TopCompaniesList({ companies }: Props) {
  // Default hides LOW and sorts by MED+ — LOW at most target companies
  // is dominated by HR / recruiter noise that distorts the ranking.
  const [visibleLevels, setVisibleLevels] = useState<Set<Level>>(
    new Set(["BV", "HIGH", "MEDIUM"]),
  );
  const [sortBy, setSortBy] = useState<SortBy>("med+");

  const toggleLevel = (l: Level) => {
    setVisibleLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      // Disallow empty selection — collapses to "all visible" so bars
      // never disappear entirely.
      return next.size === 0 ? new Set(LEVELS) : next;
    });
  };

  // Sort score uses full byLevel counts independent of which levels
  // are currently displayed. Lets the user say "rank by senior-role
  // count" via HIGH+ while visually focusing on something else.
  const sortScore = (c: CompanyData): number => {
    if (sortBy === "high+") return c.byLevel.BV + c.byLevel.HIGH;
    if (sortBy === "med+")
      return c.byLevel.BV + c.byLevel.HIGH + c.byLevel.MEDIUM;
    return c.byLevel.BV + c.byLevel.HIGH + c.byLevel.MEDIUM + c.byLevel.LOW;
  };

  const sorted = [...companies]
    .sort((a, b) => sortScore(b) - sortScore(a))
    .slice(0, 10);

  const visibleSum = (c: CompanyData): number =>
    LEVELS.filter((l) => visibleLevels.has(l)).reduce(
      (sum, l) => sum + c.byLevel[l],
      0,
    );

  const maxVisible = Math.max(...sorted.map(visibleSum), 1);

  return (
    <section>
      <h2 className="mb-4 text-sm font-semibold tracking-tight text-stone-700">
        Top 10 companies by open roles
      </h2>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {LEVELS.map((level) => {
            const active = visibleLevels.has(level);
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-opacity hover:bg-stone-100 ${
                  active ? "text-stone-700" : "text-stone-400"
                }`}
                title={active ? `Hide ${level} segments` : `Show ${level} segments`}
              >
                <span
                  className={`h-2 w-2 rounded-sm ${LEVEL_BAR_COLOR[level]} ${
                    active ? "" : "opacity-30"
                  }`}
                />
                {LEVEL_LABEL[level]}
              </button>
            );
          })}
        </div>
        <div className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white p-0.5">
          {(["total", "med+", "high+"] as const).map((opt) => {
            const active = sortBy === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setSortBy(opt)}
                className={`rounded-full px-3 py-1 text-xs font-medium tracking-tight transition-colors ${
                  active
                    ? "bg-stone-900 text-white"
                    : "text-stone-600 hover:text-stone-900"
                }`}
                title={`Sort by ${SORT_LABEL[opt]}`}
              >
                {SORT_LABEL[opt]}
              </button>
            );
          })}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-white/40 p-6 text-center">
          <p className="text-sm text-stone-500">
            No open matches yet — wait for the next scan.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          {sorted.map((entry, i) => {
            const vis = visibleSum(entry);
            return (
              <li
                key={entry.slug}
                className={`flex items-center gap-3 px-4 py-3 ${
                  i > 0 ? "border-t border-stone-100" : ""
                }`}
              >
                <span className="w-5 shrink-0 text-xs tabular-nums text-stone-400">
                  {i + 1}
                </span>
                <Link
                  href={`/all?company=${encodeURIComponent(entry.slug)}`}
                  className="w-40 shrink-0 truncate text-sm text-stone-900 hover:text-stone-950 hover:underline"
                  title={`See all ${entry.name} roles`}
                >
                  {entry.name}
                </Link>
                <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-stone-100">
                  <div
                    className="flex h-full"
                    style={{ width: `${(vis / maxVisible) * 100}%` }}
                  >
                    {LEVELS.filter((l) => visibleLevels.has(l)).map((level) =>
                      entry.byLevel[level] > 0 ? (
                        <Link
                          key={level}
                          href={`/all?company=${encodeURIComponent(entry.slug)}&levels=${level}`}
                          className={`h-full ${LEVEL_BAR_COLOR[level]} transition-opacity hover:opacity-80`}
                          style={{
                            width: `${(entry.byLevel[level] / vis) * 100}%`,
                          }}
                          title={`${entry.byLevel[level]} ${LEVEL_LABEL[level]} role${
                            entry.byLevel[level] === 1 ? "" : "s"
                          } at ${entry.name} — click to filter`}
                        />
                      ) : null,
                    )}
                  </div>
                </div>
                <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-stone-700">
                  {vis}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
