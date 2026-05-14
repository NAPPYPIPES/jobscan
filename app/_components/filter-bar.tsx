"use client";

import type { Level, Sector } from "@/lib/scan/types";

export type Since = "24h" | "48h" | "72h";

// Sort modes for the company-group ordering.
//   activity — most-roles-first
//   alpha    — A→Z by company name
//   level    — companies whose best role is BV first, then HIGH, etc.
//   score    — companies whose highest fit_score is best first; unscored
//              rows fall back to a level-derived synthetic score in
//              MatchesView so they don't trail dead-last
export const ALL_SORTS = ["activity", "alpha", "level", "score"] as const;
export type Sort = (typeof ALL_SORTS)[number];

const SORT_OPTIONS: { value: Sort; label: string; title: string }[] = [
  { value: "activity", label: "Activity", title: "Most-active companies first" },
  { value: "alpha", label: "A–Z", title: "Companies alphabetical" },
  { value: "level", label: "Level", title: "Companies with best level first (BV → HIGH → MED → LOW)" },
  { value: "score", label: "Score", title: "Companies with best fit score first" },
];

const LEVELS: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];
const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};

const SECTORS: Sector[] = ["tech", "finserv", "other"];
const SECTOR_LABEL: Record<Sector, string> = {
  tech: "Tech",
  finserv: "Financial Services",
  other: "Other",
};

const LEVEL_ACTIVE: Record<Level, string> = {
  BV: "bg-indigo-600 text-white ring-indigo-600",
  HIGH: "bg-rose-600 text-white ring-rose-600",
  MEDIUM: "bg-amber-600 text-white ring-amber-600",
  LOW: "bg-stone-800 text-white ring-stone-800",
};

const SINCE_OPTIONS: { value: Since; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "48h", label: "48h" },
  { value: "72h", label: "72h" },
];

function Checkbox({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border bg-white ${
        active ? "border-stone-700" : "border-stone-300"
      }`}
    >
      {active && (
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5 text-stone-900"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 6.5l2.2 2.2L9.5 3.5" />
        </svg>
      )}
    </span>
  );
}

type Props = {
  selectedLevels: Set<Level>;
  onToggleLevel: (level: Level) => void;
  levelCounts: Record<Level, number>;
  since?: Since;
  onChangeSince?: (s: Since) => void;
  sinceCounts?: Record<Since, number>;
  selectedSectors: Set<Sector>;
  onToggleSector: (s: Sector) => void;
  sectorCounts: Record<Sector, number>;
  companyFilter: string | null;
  onClearCompany: () => void;
  searchQuery: string;
  onChangeSearch: (q: string) => void;
  sort: Sort;
  onChangeSort: (s: Sort) => void;
  totalShown: number;
  totalAvailable: number;
};

export default function FilterBar({
  selectedLevels,
  onToggleLevel,
  levelCounts,
  since,
  onChangeSince,
  sinceCounts,
  selectedSectors,
  onToggleSector,
  sectorCounts,
  companyFilter,
  onClearCompany,
  searchQuery,
  onChangeSearch,
  sort,
  onChangeSort,
  totalShown,
  totalAvailable,
}: Props) {
  return (
    <div className="flex flex-col gap-4 border-b border-stone-200/70 pb-6">
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onChangeSearch(e.target.value)}
          placeholder="Search by company"
          className="w-full rounded-lg border border-stone-200 bg-white px-3.5 py-2 pr-9 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          aria-label="Search by company"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onChangeSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
          Level
        </span>
        {LEVELS.map((level) => {
          const active = selectedLevels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => onToggleLevel(level)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium tracking-tight ring-1 ring-inset transition-all ${
                active
                  ? LEVEL_ACTIVE[level]
                  : "bg-white text-stone-600 ring-stone-200 hover:ring-stone-300"
              }`}
            >
              <Checkbox active={active} />
              <span>{LEVEL_LABEL[level]}</span>
              <span
                className={`tabular-nums ${
                  active ? "text-white/70" : "text-stone-400"
                }`}
              >
                {levelCounts[level]}
              </span>
            </button>
          );
        })}
      </div>

      {since !== undefined && onChangeSince && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
            Posted within
          </span>
          <div className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white p-0.5">
            {SINCE_OPTIONS.map((opt) => {
              const active = since === opt.value;
              const count = sinceCounts?.[opt.value];
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChangeSince(opt.value)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium tracking-tight transition-colors ${
                    active
                      ? "bg-stone-900 text-white"
                      : "text-stone-600 hover:text-stone-900"
                  }`}
                >
                  <span>{opt.label}</span>
                  {count !== undefined && (
                    <span
                      className={`tabular-nums ${
                        active ? "text-white/70" : "text-stone-400"
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
          Sector
        </span>
        {SECTORS.map((sector) => {
          const active = selectedSectors.has(sector);
          return (
            <button
              key={sector}
              type="button"
              onClick={() => onToggleSector(sector)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium tracking-tight ring-1 ring-inset transition-all ${
                active
                  ? "bg-stone-900 text-white ring-stone-900"
                  : "bg-white text-stone-600 ring-stone-200 hover:ring-stone-300"
              }`}
            >
              <Checkbox active={active} />
              <span>{SECTOR_LABEL[sector]}</span>
              <span
                className={`tabular-nums ${
                  active ? "text-white/70" : "text-stone-400"
                }`}
              >
                {sectorCounts[sector]}
              </span>
            </button>
          );
        })}
      </div>

      {companyFilter && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
            Company
          </span>
          <button
            type="button"
            onClick={onClearCompany}
            className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-1 text-xs font-medium tracking-tight text-white transition-opacity hover:opacity-80"
            title="Clear company filter"
          >
            <span>{companyFilter}</span>
            <span aria-hidden className="text-white/70">×</span>
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-stone-400">
          Sort
        </span>
        <div className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white p-0.5">
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChangeSort(opt.value)}
                title={opt.title}
                className={`rounded-full px-3 py-1 text-xs font-medium tracking-tight transition-colors ${
                  active
                    ? "bg-stone-900 text-white"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs tabular-nums text-stone-500">
        Showing <span className="font-semibold text-stone-900">{totalShown}</span>{" "}
        of {totalAvailable}
      </p>
    </div>
  );
}
