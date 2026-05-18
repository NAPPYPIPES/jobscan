"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Level, Sector } from "@/lib/scan/types";
import type { Role } from "@/lib/auth/cookie";
import FilterBar, { type Since, type Sort, ALL_SORTS } from "./filter-bar";
import MatchCard, { type MatchWithUrl } from "./match-card";
import CompanyHeader from "./company-header";
import { COMPANY_DOMAINS } from "@/lib/scan/logos";

// Sector lookup. Server-side enrichment passes a small slug → sector
// dict alongside the matches array so the client doesn't have to
// import @/lib/scan/targets (which now reads from node:fs at module
// load and can't run on the client). Unknown slugs fall through to
// "tech" — matches the default in sectorForSlug on the server.
function makeSectorLookup(map: Record<string, Sector>) {
  return (slug: string): Sector => map[slug] ?? "tech";
}

const ALL_LEVELS: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];
// Best-practice default: hide LOW noise. BV/HIGH/MEDIUM are the
// actionable levels (MEDIUM with fit_score ≥ alertThreshold goes into
// the daily digest). LOW chip stays visible so the user can opt in.
const DEFAULT_LEVELS: Level[] = ["BV", "HIGH", "MEDIUM"];
const ALL_SECTORS: Sector[] = ["tech", "finserv", "other"];
const SINCE_HOURS: Record<Since, number> = { "24h": 24, "48h": 48, "72h": 72 };

// Synthetic fit score for sorting unscored rows (Workday roles, LOW
// roles). Mapped from level so they slot reasonably amongst real
// scores rather than dead-last. Display never shows these — only the
// real fit_score appears on the card.
const SYNTHETIC_SCORE: Record<Level, number> = {
  BV: 8.5,
  HIGH: 8.0,
  MEDIUM: 6.0,
  LOW: 4.0,
};

function effectiveScore(m: MatchWithUrl): number {
  if (m.fitScore != null) return parseFloat(m.fitScore);
  return SYNTHETIC_SCORE[m.level];
}

type Props = {
  matches: MatchWithUrl[];
  mode: "recent" | "all";
  // Slug → sector lookup, built server-side in the page component.
  // Avoids the client having to import the server-only targets module.
  sectorBySlug: Record<string, Sector>;
  // Resolved by the server page from the x-par-role middleware
  // header. Threaded through to every MatchCard so demo viewers get
  // disabled mutation controls + tooltips.
  viewerRole: Role;
};

export default function MatchesView({ matches, mode, sectorBySlug, viewerRole }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const sectorForSlug = makeSectorLookup(sectorBySlug);

  const defaultLevels = useMemo<Set<Level>>(() => new Set(DEFAULT_LEVELS), []);

  const levelsParam = params.get("levels");
  const explicitLevels = useMemo<Set<Level> | null>(() => {
    if (!levelsParam) return null;
    const parsed = levelsParam
      .split(",")
      .filter((v): v is Level => ALL_LEVELS.includes(v as Level));
    return parsed.length ? new Set(parsed) : null;
  }, [levelsParam]);
  const selectedLevels = explicitLevels ?? defaultLevels;

  const since: Since = (() => {
    const v = params.get("since");
    if (v === "24h" || v === "48h" || v === "72h") return v;
    return "24h";
  })();

  const sort: Sort = (() => {
    const v = params.get("sort");
    return ALL_SORTS.includes(v as Sort) ? (v as Sort) : "score";
  })();

  const sectorsParam = params.get("sectors");
  const selectedSectors = useMemo<Set<Sector>>(() => {
    if (!sectorsParam) return new Set(ALL_SECTORS);
    const parsed = sectorsParam
      .split(",")
      .filter((v): v is Sector => ALL_SECTORS.includes(v as Sector));
    return new Set(parsed.length ? parsed : ALL_SECTORS);
  }, [sectorsParam]);

  const companyParam = params.get("company");
  const companyDisplayName = useMemo(() => {
    if (!companyParam) return null;
    const m = matches.find((row) => row.companySlug === companyParam);
    return m?.companyDisplayName ?? companyParam;
  }, [matches, companyParam]);

  const searchQuery = params.get("q") ?? "";

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  const onToggleLevel = (level: Level) => {
    // Toggle from the *currently-visible* set (defaultLevels when no
    // explicit override yet) so clicking a visible chip deselects it
    // and clicking a hidden chip selects it — matches what the user
    // sees on screen, regardless of how the URL got there.
    const next = new Set(selectedLevels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    if (next.size === 0) {
      setParam("levels", null);
      return;
    }
    // Clean URL: if the new set matches the default exactly, drop the
    // levels param entirely so the URL doesn't carry redundant state.
    const matchesDefault =
      next.size === defaultLevels.size &&
      Array.from(defaultLevels).every((l) => next.has(l));
    if (matchesDefault) {
      setParam("levels", null);
      return;
    }
    setParam("levels", ALL_LEVELS.filter((l) => next.has(l)).join(","));
  };

  const onChangeSort = (s: Sort) => {
    setParam("sort", s === "score" ? null : s);
  };

  const onChangeSince = (s: Since) => {
    setParam("since", s === "24h" ? null : s);
  };

  const onToggleSector = (sector: Sector) => {
    const next = new Set(selectedSectors);
    if (next.has(sector)) next.delete(sector);
    else next.add(sector);
    if (next.size === 0 || next.size === ALL_SECTORS.length) {
      setParam("sectors", null);
    } else {
      setParam("sectors", ALL_SECTORS.filter((s) => next.has(s)).join(","));
    }
  };

  const onClearCompany = () => setParam("company", null);
  const onChangeSearch = (q: string) => setParam("q", q || null);
  // Pin a specific company (strict slug filter). Clears the loose
  // text query so the chip filter is the only active narrowing —
  // avoids the confusing "company chip + text search both active"
  // state that produces zero results when the query doesn't match
  // the selected company name.
  const onSelectCompany = (slug: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("company", slug);
    next.delete("q");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  const inWindow = useMemo(() => {
    if (mode === "all") return matches;
    const cutoff = Date.now() - SINCE_HOURS[since] * 3_600_000;
    return matches.filter((m) => m.firstSeen.getTime() >= cutoff);
  }, [matches, mode, since]);

  const sinceCounts: Record<Since, number> = useMemo(() => {
    if (mode === "all") return { "24h": 0, "48h": 0, "72h": 0 };
    const now = Date.now();
    const counts: Record<Since, number> = { "24h": 0, "48h": 0, "72h": 0 };
    for (const m of matches) {
      const ageH = (now - m.firstSeen.getTime()) / 3_600_000;
      if (ageH <= 24) counts["24h"]++;
      if (ageH <= 48) counts["48h"]++;
      if (ageH <= 72) counts["72h"]++;
    }
    return counts;
  }, [matches, mode]);

  const sectorCounts: Record<Sector, number> = { tech: 0, finserv: 0, other: 0 };
  for (const m of inWindow) sectorCounts[sectorForSlug(m.companySlug)]++;

  const inSector = useMemo(() => {
    if (selectedSectors.size === ALL_SECTORS.length) return inWindow;
    return inWindow.filter((m) => selectedSectors.has(sectorForSlug(m.companySlug)));
  }, [inWindow, selectedSectors]);

  // Distinct companies in the current sector-filtered set, with their
  // role counts. Drives the autocomplete dropdown. We compute against
  // inSector (not visible) so the suggestion list reflects what the
  // user can actually navigate to, including levels they've filtered
  // out — typing "an" should still find Anthropic even if BV is
  // currently deselected.
  const companyOptions = useMemo(() => {
    const map = new Map<string, { slug: string; displayName: string; count: number }>();
    for (const m of inSector) {
      let row = map.get(m.companySlug);
      if (!row) {
        row = { slug: m.companySlug, displayName: m.companyDisplayName, count: 0 };
        map.set(m.companySlug, row);
      }
      row.count++;
    }
    return Array.from(map.values()).map((r) => ({
      ...r,
      domain: COMPANY_DOMAINS[r.slug],
    }));
  }, [inSector]);

  const inCompany = useMemo(() => {
    if (!companyParam) return inSector;
    return inSector.filter((m) => m.companySlug === companyParam);
  }, [inSector, companyParam]);

  const inSearch = useMemo(() => {
    if (!searchQuery.trim()) return inCompany;
    const q = searchQuery.trim().toLowerCase();
    return inCompany.filter((m) =>
      m.companyDisplayName.toLowerCase().includes(q),
    );
  }, [inCompany, searchQuery]);

  const levelCounts: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const m of inSearch) levelCounts[m.level]++;

  const visible = inSearch.filter((m) => selectedLevels.has(m.level));

  const grouped = useMemo(() => {
    type Group = { slug: string; displayName: string; matches: MatchWithUrl[] };
    const map = new Map<string, Group>();
    for (const m of visible) {
      let g = map.get(m.companySlug);
      if (!g) {
        g = { slug: m.companySlug, displayName: m.companyDisplayName, matches: [] };
        map.set(m.companySlug, g);
      }
      g.matches.push(m);
    }
    const groups = Array.from(map.values());

    if (sort === "score") {
      for (const g of groups) {
        g.matches.sort((a, b) => {
          const sa = effectiveScore(a);
          const sb = effectiveScore(b);
          if (sa !== sb) return sb - sa;
          return b.firstSeen.getTime() - a.firstSeen.getTime();
        });
      }
    }

    groups.sort((a, b) => {
      if (sort === "score") {
        const aBest = Math.max(...a.matches.map(effectiveScore));
        const bBest = Math.max(...b.matches.map(effectiveScore));
        if (aBest !== bBest) return bBest - aBest;
        return a.displayName.localeCompare(b.displayName);
      }
      // sort === "activity": most-roles-first, alpha tie-break.
      if (b.matches.length !== a.matches.length) {
        return b.matches.length - a.matches.length;
      }
      return a.displayName.localeCompare(b.displayName);
    });

    return groups;
  }, [visible, sort]);

  // Flat list ordered by effective score desc, used by the score-sort
  // layout. Independent of `grouped` (which still groups by company
  // even under sort=score). Tie-break by recency so two equal-score
  // roles surface the newer one first.
  const flatByScore = useMemo(() => {
    if (sort !== "score") return [] as MatchWithUrl[];
    return [...visible].sort((a, b) => {
      const sa = effectiveScore(a);
      const sb = effectiveScore(b);
      if (sa !== sb) return sb - sa;
      return b.firstSeen.getTime() - a.firstSeen.getTime();
    });
  }, [visible, sort]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [openSummaryId, setOpenSummaryId] = useState<string | null>(null);
  // Stable across renders so React.memo on MatchCard can actually skip
  // re-renders. The functional setState lets us avoid depending on
  // openSummaryId in the deps array.
  const onToggleSummary = useCallback((matchId: string) => {
    setOpenSummaryId((prev) => (prev === matchId ? null : matchId));
  }, []);

  const toggleCompany = (slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const visibleSlugs = grouped.map((g) => g.slug);
  const allCollapsed =
    visibleSlugs.length > 0 && visibleSlugs.every((s) => collapsed.has(s));

  const onToggleAll = () => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (allCollapsed) for (const s of visibleSlugs) next.delete(s);
      else for (const s of visibleSlugs) next.add(s);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <FilterBar
        selectedLevels={selectedLevels}
        onToggleLevel={onToggleLevel}
        levelCounts={levelCounts}
        since={mode === "recent" ? since : undefined}
        onChangeSince={mode === "recent" ? onChangeSince : undefined}
        sinceCounts={mode === "recent" ? sinceCounts : undefined}
        selectedSectors={selectedSectors}
        onToggleSector={onToggleSector}
        sectorCounts={sectorCounts}
        companyFilter={companyDisplayName}
        onClearCompany={onClearCompany}
        searchQuery={searchQuery}
        onChangeSearch={onChangeSearch}
        companyOptions={companyOptions}
        onSelectCompany={onSelectCompany}
        sort={sort}
        onChangeSort={onChangeSort}
        totalShown={visible.length}
        totalAvailable={inSearch.length}
      />

      {visible.length === 0 ? (
        <div className="empty-state p-12 text-center">
          <p className="text-sm text-fg-subtle">
            {mode === "recent"
              ? `No new matches in the last ${since}.`
              : "No matches with current filters."}
          </p>
        </div>
      ) : sort === "score" ? (
        // Flat score-sort layout. Drops the company section headers
        // and renders every visible row in a single descending list.
        // Each row gets a small company-logo prefix so the user can
        // still tell which company it's at without the section header.
        // No "Collapse all" button — there are no groups to collapse.
        <ul className="flex flex-col gap-2">
          {flatByScore.map((m) => (
            <li key={m.id}>
              <MatchCard
                m={m}
                isSummaryOpen={openSummaryId === m.id}
                onToggleSummary={onToggleSummary}
                viewerRole={viewerRole}
                showCompanyLogo
                companyDomain={COMPANY_DOMAINS[m.companySlug]}
              />
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="-mt-2 flex justify-end">
            <button
              type="button"
              onClick={onToggleAll}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted shadow-card transition-colors hover:border-line-strong hover:bg-muted hover:text-fg"
            >
              <span aria-hidden className="text-base leading-none text-fg-subtle">
                {allCollapsed ? "+" : "−"}
              </span>
              <span>{allCollapsed ? "Expand all" : "Collapse all"}</span>
            </button>
          </div>
          <div className="flex flex-col gap-10">
            {grouped.map((group) => {
              const isCollapsed = collapsed.has(group.slug);
              return (
                <section key={group.slug}>
                  <CompanyHeader
                    displayName={group.displayName}
                    domain={COMPANY_DOMAINS[group.slug]}
                    count={group.matches.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggleCompany(group.slug)}
                  />
                  {!isCollapsed && (
                    <ul className="flex flex-col gap-2">
                      {group.matches.map((m) => (
                        <li key={m.id}>
                          <MatchCard
                            m={m}
                            isSummaryOpen={openSummaryId === m.id}
                            onToggleSummary={onToggleSummary}
                            viewerRole={viewerRole}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
