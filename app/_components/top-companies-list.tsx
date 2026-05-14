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
  BV: "bg-indigo-600 dark:bg-indigo-500",
  HIGH: "bg-rose-600 dark:bg-rose-500",
  MEDIUM: "bg-amber-500 dark:bg-amber-400",
  LOW: "bg-stone-400 dark:bg-stone-500",
};

// Single scope filter that defines which levels are counted, sorted,
// AND drawn. The previous design split this into two independent
// controls (legend visibility + sort selector) — picking HIGH+ as the
// sort while leaving MEDIUM visible in the legend made the count
// column show MED+ totals while the order was by HIGH+, so #1 by
// HIGH+ could have a smaller displayed number than #3 by MED+. One
// control = one mental model.
type Scope = "bv" | "high+" | "med+" | "total";
const SCOPES: { value: Scope; label: string; levels: Level[] }[] = [
  { value: "bv",     label: "BV",    levels: ["BV"] },
  { value: "high+",  label: "HIGH+", levels: ["BV", "HIGH"] },
  { value: "med+",   label: "MED+",  levels: ["BV", "HIGH", "MEDIUM"] },
  { value: "total",  label: "Total", levels: ["BV", "HIGH", "MEDIUM", "LOW"] },
];
const SCOPE_LEVELS: Record<Scope, Level[]> = Object.fromEntries(
  SCOPES.map((s) => [s.value, s.levels]),
) as Record<Scope, Level[]>;

export type CompanyData = {
  name: string;
  slug: string;
  byLevel: Record<Level, number>;
};

type Props = { companies: CompanyData[] };

// Top 10 companies by open roles within the selected scope. Each
// segment + the company name are clickable links into /all with the
// matching company + level filters applied.
export default function TopCompaniesList({ companies }: Props) {
  // Default to MED+ — LOW at most target companies is dominated by HR
  // / recruiter noise that distorts the ranking.
  const [scope, setScope] = useState<Scope>("med+");
  const scopeLevels = SCOPE_LEVELS[scope];

  const scopeSum = (c: CompanyData): number =>
    scopeLevels.reduce((sum, l) => sum + c.byLevel[l], 0);

  // Drop companies with zero in scope (e.g. picking BV when most
  // companies have none) — saves a long tail of empty rows.
  const sorted = [...companies]
    .map((c) => ({ ...c, scope: scopeSum(c) }))
    .filter((c) => c.scope > 0)
    .sort((a, b) => b.scope - a.scope)
    .slice(0, 10);

  const maxScope = Math.max(...sorted.map((c) => c.scope), 1);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-fg-muted">
          Top 10 companies by open roles
        </h2>
        <div className="inline-flex items-center gap-1 rounded-full border border-line bg-surface p-0.5">
          {SCOPES.map((opt) => {
            const active = scope === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setScope(opt.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium tracking-tight transition-colors ${
                  active
                    ? "bg-fg text-canvas"
                    : "text-fg-muted hover:text-fg"
                }`}
                title={`Count + sort by ${opt.label}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="empty-state p-6 text-center">
          <p className="text-sm text-fg-subtle">
            No companies have any {SCOPES.find((s) => s.value === scope)?.label} roles right now.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          {sorted.map((entry, i) => (
            <li
              key={entry.slug}
              className={`flex items-center gap-3 px-4 py-3 ${
                i > 0 ? "border-t border-line-subtle" : ""
              }`}
            >
              <span className="w-5 shrink-0 font-mono text-xs tabular-nums text-fg-subtle">
                {i + 1}
              </span>
              <Link
                href={`/all?company=${encodeURIComponent(entry.slug)}`}
                className="w-40 shrink-0 truncate text-sm text-fg hover:underline"
                title={`See all ${entry.name} roles`}
              >
                {entry.name}
              </Link>
              <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="flex h-full"
                  style={{ width: `${(entry.scope / maxScope) * 100}%` }}
                >
                  {scopeLevels.map((level) =>
                    entry.byLevel[level] > 0 ? (
                      <Link
                        key={level}
                        href={`/all?company=${encodeURIComponent(entry.slug)}&levels=${level}`}
                        className={`h-full ${LEVEL_BAR_COLOR[level]} transition-opacity hover:opacity-80`}
                        style={{
                          width: `${(entry.byLevel[level] / entry.scope) * 100}%`,
                        }}
                        title={`${entry.byLevel[level]} ${LEVEL_LABEL[level]} role${
                          entry.byLevel[level] === 1 ? "" : "s"
                        } at ${entry.name} — click to filter`}
                      />
                    ) : null,
                  )}
                </div>
              </div>
              <span className="w-10 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-fg">
                {entry.scope}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
