import { and, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { matches, targets, userMatches } from "./schema";
import { LEVEL_ORDER, type CompanyResult } from "@/lib/scan/types";
import type { Match, MatchStatus, DismissReason } from "./schema";

// Phase 4: every read returns per-user state by JOINing matches (the
// global one-row-per-real-job catalog) against user_matches (the
// per-(user, match) state table). The shape returned mirrors the
// legacy Match type so existing UI components keep working — fields
// that used to live on matches.* (status, fit_score, level, etc.)
// are sourced from user_matches and merged into the returned object.

// Convenience: the columns we project from a JOINed select so the
// returned shape exactly matches the legacy Match (lots of UI code
// references match.status, match.fitScore, etc.).
const joinedSelect = {
  // Global columns from matches.*
  id: matches.id,
  ats: matches.ats,
  companySlug: matches.companySlug,
  companyDisplayName: matches.companyDisplayName,
  jobId: matches.jobId,
  title: matches.title,
  location: matches.location,
  firstSeen: matches.firstSeen,
  lastSeen: matches.lastSeen,
  closedAt: matches.closedAt,
  createdAt: matches.createdAt,
  // Per-user columns from user_matches.*
  level: userMatches.level,
  status: userMatches.status,
  isBaseline: userMatches.isBaseline,
  appliedAt: userMatches.appliedAt,
  dismissedAt: userMatches.dismissedAt,
  dismissReason: userMatches.dismissReason,
  fitScore: userMatches.fitScore,
  fitSummary: userMatches.fitSummary,
  fitFlag: userMatches.fitFlag,
  tier1Score: userMatches.tier1Score,
  tier1Confidence: userMatches.tier1Confidence,
  tier1IsPotentialBv: userMatches.tier1IsPotentialBv,
  tier1QuickTake: userMatches.tier1QuickTake,
  pendingBvVerification: userMatches.pendingBvVerification,
  bvReasoning: userMatches.bvReasoning,
  updatedAt: userMatches.updatedAt,
};

// Read all non-dismissed matches for the UI. Sorted by level rank (BV →
// LOW), then first_seen DESC within each level, so the highest-priority
// and most-recently-discovered roles surface first.
//
// `excludeApplied`: Recent (/) hides applied roles entirely so the view
// stays a to-do list. /all keeps them (the UI fades them in place).
//
// `excludeBaseline`: Recent (/) needs to drop is_baseline=true rows.
// Those rows are first-scan-of-a-newly-added-company carry-over and would
// otherwise pollute the 24h window with hundreds of rows.
//
// `userId`: scope to the signed-in user's user_matches rows. Demo
// user sees their own pre-seeded curated subset.
export async function getActiveMatches(
  userId: string,
  opts: {
    excludeApplied?: boolean;
    excludeBaseline?: boolean;
  } = {},
): Promise<Match[]> {
  const db = getDb();
  const conditions = [
    eq(userMatches.userId, userId),
    ne(userMatches.status, "dismissed"),
    isNull(matches.closedAt),
  ];
  if (opts.excludeApplied) conditions.push(ne(userMatches.status, "applied"));
  if (opts.excludeBaseline) conditions.push(eq(userMatches.isBaseline, false));

  const rows = await db
    .select(joinedSelect)
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(and(...conditions))
    .orderBy(desc(matches.firstSeen));

  return (rows as unknown as Match[]).sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
  );
}

// Write one row's status. Returns the (userId, matchId) tuple on
// success, or null if no row matched. Used by PATCH /api/matches/[id].
//
// applied_at is maintained alongside status: set to now() on transition
// to 'applied', cleared on transition to 'new', untouched for other
// statuses.
export async function setMatchStatus(
  userId: string,
  matchId: string,
  status: MatchStatus,
): Promise<{ id: string; status: string } | null> {
  const db = getDb();
  const setClause: Record<string, unknown> = {
    status,
    updatedAt: sql`now()`,
  };
  if (status === "applied") setClause.appliedAt = sql`now()`;
  else if (status === "new") setClause.appliedAt = null;

  const updated = await db
    .update(userMatches)
    .set(setClause)
    .where(and(eq(userMatches.userId, userId), eq(userMatches.matchId, matchId)))
    .returning({ id: userMatches.matchId, status: userMatches.status });
  return updated[0] ?? null;
}

// Dismiss with optional reason tags. Distinct from setMatchStatus so
// the dismiss-reason payload can be set in the same UPDATE without
// every status mutation having to pass it.
export async function dismissMatch(
  userId: string,
  matchId: string,
  reasons: DismissReason[] | null,
): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(userMatches)
    .set({
      status: "dismissed",
      dismissedAt: sql`now()`,
      dismissReason: reasons,
      updatedAt: sql`now()`,
    })
    .where(and(eq(userMatches.userId, userId), eq(userMatches.matchId, matchId)))
    .returning({ id: userMatches.matchId });
  return updated.length > 0;
}

// Pull digest candidates for a single user: BV/HIGH/MEDIUM in the
// lookback window, dismissed + baseline rows excluded. Phase 6 will
// loop this per user across the digest cron.
export async function getRecentAlertCandidates(
  userId: string,
  since: Date,
): Promise<Match[]> {
  const db = getDb();
  const rows = await db
    .select(joinedSelect)
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        gte(matches.firstSeen, since),
        inArray(userMatches.level, ["BV", "HIGH", "MEDIUM"]),
        ne(userMatches.status, "dismissed"),
        eq(userMatches.isBaseline, false),
        isNull(matches.closedAt),
      ),
    )
    .orderBy(desc(matches.firstSeen));
  return (rows as unknown as Match[]).sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
  );
}

// Return a per-slug set of job IDs currently in the GLOBAL matches
// table. Feeds the scan's diff detector — net-new is global (the same
// job posting is "new" for everyone the first time we see it), so
// this stays scoped to matches and doesn't need to know about users.
export async function loadPriorIdsBySlug(): Promise<Map<string, Set<string>>> {
  const db = getDb();
  const rows = await db
    .select({
      companySlug: matches.companySlug,
      jobId: matches.jobId,
    })
    .from(matches);

  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = map.get(row.companySlug);
    if (!set) {
      set = new Set<string>();
      map.set(row.companySlug, set);
    }
    set.add(row.jobId);
  }
  return map;
}

// Upsert every match from a scan run AND actively close any prior row
// for a successful slug whose jobId wasn't returned this run. UNCHANGED
// from Phase 3 — writes are still to the global matches table. Per-user
// fan-out happens AFTER this function returns; see lib/scan/run.ts.
//
// Only successful slugs trigger closure — failed-fetch slugs are
// skipped entirely so a transient ATS outage doesn't auto-close every
// match for that company.
//
// `baselineSlugs` = slugs whose first-ever scan this is. Their rows
// insert with is_baseline=true on the global matches table; the
// fan-out helper propagates that flag to user_matches.
export async function persistScanResults(
  results: CompanyResult[],
  baselineSlugs: Set<string>,
): Promise<void> {
  const db = getDb();
  const successfulSlugs = results.map((r) => r.slug);

  const rows = results.flatMap((r) =>
    r.matches.map((m) => ({
      ats: r.ats,
      companySlug: r.slug,
      companyDisplayName: r.displayName,
      jobId: m.id,
      level: m.level,
      title: m.title,
      location: m.location,
      isBaseline: baselineSlugs.has(r.slug),
    })),
  );

  if (rows.length > 0) {
    await db
      .insert(matches)
      .values(rows)
      .onConflictDoUpdate({
        target: [matches.ats, matches.companySlug, matches.jobId],
        set: {
          lastSeen: sql`now()`,
          updatedAt: sql`now()`,
          title: sql`excluded.title`,
          location: sql`excluded.location`,
          companyDisplayName: sql`excluded.company_display_name`,
          closedAt: sql`NULL`,
        },
      });
  }

  // Per-slug closure pass. Closures are GLOBAL — when a job leaves
  // the ATS, it's closed for everyone. No per-user closure write is
  // needed; the read path filters on matches.closed_at IS NULL.
  for (const r of results) {
    const currentJobIds = r.matches.map((m) => m.id);
    const baseFilter = and(
      eq(matches.companySlug, r.slug),
      isNull(matches.closedAt),
    );
    const where =
      currentJobIds.length === 0
        ? baseFilter
        : and(baseFilter, notInArray(matches.jobId, currentJobIds));
    await db
      .update(matches)
      .set({ closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(where);
  }

  if (successfulSlugs.length > 0) {
    await db
      .update(targets)
      .set({ lastSuccessAt: sql`now()` })
      .where(inArray(targets.slug, successfulSlugs));
  }
}
