"use client";

import type { Level, Sector } from "@/lib/scan/types";
import CompanySearch, { type CompanyOption } from "./company-search";

export type Since = "24h" | "48h" | "72h";

// Sort modes.
//   score    — flat list, best fit_score first (default — primary view
//              for "what should I look at?"). Unscored rows fall back
//              to a level-derived synthetic score in MatchesView so
//              they don't trail dead-last.
//   activity — group by company, most-roles-first (alternative for
//              browsing a target's full board).
// alpha + level were dropped in the "best practice defaults" reset:
//   alpha is reachable via the company search box; level is strictly
//   redundant with score (level is just bucketed fit_score).
export const ALL_SORTS = ["score", "activity"] as const;
export type Sort = (typeof ALL_SORTS)[number];

const SORT_OPTIONS: { value: Sort; label: string; title: string }[] = [
  { value: "score", label: "Best fit", title: "Highest fit_score first (flat list)" },
  { value: "activity", label: "By company", title: "Group by company, most-active first" },
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
  BV: "bg-indigo-600 text-white ring-indigo-600 dark:bg-indigo-500 dark:ring-indigo-500",
  HIGH: "bg-rose-600 text-white ring-rose-600 dark:bg-rose-500 dark:ring-rose-500",
  MEDIUM: "bg-amber-600 text-white ring-amber-600 dark:bg-amber-500 dark:ring-amber-500",
  LOW: "bg-fg text-canvas ring-fg",
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
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border bg-surface ${
        active ? "border-fg" : "border-line-strong"
      }`}
    >
      {active && (
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5 text-fg"
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
  // Full set of distinct companies in the current view (post level/
  // sector/since filters). Drives the autocomplete dropdown.
  companyOptions: CompanyOption[];
  onSelectCompany: (slug: string) => void;
  sort: Sort;
  onChangeSort: (s: Sort) => void;
  totalShown: number;
  totalAvailable: number;
};

// Tap-target sizing notes. Mobile gets py-2 (~36px tall) which is just
// shy of the 44px HIG ideal but reads as an actionable button rather
// than a tag; desktop gets the original tighter py-1. Padding x stays
// consistent. The size differential is set per-chip via classes below.
const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium tracking-tight ring-1 ring-inset transition-all sm:py-1 sm:text-xs";
const CHIP_OFF =
  "bg-surface text-fg-muted ring-line hover:ring-line-strong";

const SEGMENT_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium tracking-tight transition-colors sm:py-1 sm:text-xs";
const SEGMENT_OFF = "text-fg-muted hover:text-fg";
const SEGMENT_ON = "bg-fg text-canvas";

// Section-label helper. Block on mobile so chips wrap cleanly under
// the label rather than fighting it for horizontal space; inline-block
// on desktop where the original "label + chips on one row" reads fine.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-medium uppercase tracking-wider text-fg-subtle sm:mr-1 sm:inline">
      {children}
    </span>
  );
}

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
  companyOptions,
  onSelectCompany,
  sort,
  onChangeSort,
  totalShown,
  totalAvailable,
}: Props) {
  return (
    <div className="flex flex-col gap-4 border-b border-line/70 pb-6 sm:gap-3">
      <CompanySearch
        companies={companyOptions}
        query={searchQuery}
        onChangeQuery={onChangeSearch}
        onSelectCompany={onSelectCompany}
        pinnedCompanyName={companyFilter}
        onClearPinned={onClearCompany}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>Level</SectionLabel>
        {LEVELS.map((level) => {
          const active = selectedLevels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => onToggleLevel(level)}
              className={`${CHIP_BASE} ${active ? LEVEL_ACTIVE[level] : CHIP_OFF}`}
            >
              <Checkbox active={active} />
              <span>{LEVEL_LABEL[level]}</span>
              <span
                className={`font-mono tabular-nums ${
                  active ? "text-white/70" : "text-fg-subtle"
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
          <SectionLabel>Posted within</SectionLabel>
          <div className="inline-flex items-center gap-1 rounded-full border border-line bg-surface p-0.5">
            {SINCE_OPTIONS.map((opt) => {
              const active = since === opt.value;
              const count = sinceCounts?.[opt.value];
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChangeSince(opt.value)}
                  className={`${SEGMENT_BASE} rounded-full ${active ? SEGMENT_ON : SEGMENT_OFF}`}
                >
                  <span>{opt.label}</span>
                  {count !== undefined && (
                    <span
                      className={`font-mono tabular-nums ${
                        active ? "text-canvas/70" : "text-fg-subtle"
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
        <SectionLabel>Sector</SectionLabel>
        {SECTORS.map((sector) => {
          const active = selectedSectors.has(sector);
          return (
            <button
              key={sector}
              type="button"
              onClick={() => onToggleSector(sector)}
              className={`${CHIP_BASE} ${active ? "bg-fg text-canvas ring-fg" : CHIP_OFF}`}
            >
              <Checkbox active={active} />
              <span>{SECTOR_LABEL[sector]}</span>
              <span
                className={`font-mono tabular-nums ${
                  active ? "text-canvas/70" : "text-fg-subtle"
                }`}
              >
                {sectorCounts[sector]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>Sort</SectionLabel>
        <div className="inline-flex items-center gap-1 rounded-full border border-line bg-surface p-0.5">
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChangeSort(opt.value)}
                title={opt.title}
                className={`${SEGMENT_BASE} rounded-full ${active ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-fg-muted">
        Showing{" "}
        <span className="font-mono font-semibold tabular-nums text-fg">{totalShown}</span>{" "}
        <span className="font-mono tabular-nums">of {totalAvailable}</span>
      </p>
    </div>
  );
}
