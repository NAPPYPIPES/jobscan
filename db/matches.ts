import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "./client";
import { matches } from "./schema";
import { LEVEL_ORDER, type CompanyResult } from "@/lib/scan/types";
import type { Match, MatchStatus } from "./schema";

// Read all non-dismissed matches for the UI. Sorted by level rank (BV →
// LOW), then first_seen DESC within each level, so the highest-priority
// and most-recently-discovered roles surface first. Array.sort is stable,
// so the SQL ORDER BY first_seen DESC is preserved within level groups.
//
// `excludeApplied`: Recent (/) hides applied roles entirely so the view
// stays a to-do list. /all keeps them (the UI fades them in place).
//
// `excludeBaseline`: Recent (/) needs to drop is_baseline=true rows.
// Those rows are first-scan-of-a-newly-added-company carry-over and would
// otherwise pollute the 24h window with hundreds of rows.
export async function getActiveMatches(
  opts: {
    excludeApplied?: boolean;
    excludeBaseline?: boolean;
  } = {},
): Promise<Match[]> {
  const db = getDb();
  const conditions = [ne(matches.status, "dismissed")];
  if (opts.excludeApplied) conditions.push(ne(matches.status, "applied"));
  if (opts.excludeBaseline) conditions.push(eq(matches.isBaseline, false));
  const rows = await db
    .select()
    .from(matches)
    .where(and(...conditions))
    .orderBy(desc(matches.firstSeen));
  return rows.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

// Write one row's status. Returns the row's new status on success, or
// null if no row matched the id. Used by the PATCH /api/matches/[id]
// route behind the per-card Applied toggle and × dismiss button.
//
// applied_at is maintained alongside status: set to now() on transition
// to 'applied', cleared on transition to 'new', untouched for other
// statuses.
export async function setMatchStatus(
  id: string,
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
    .update(matches)
    .set(setClause)
    .where(eq(matches.id, id))
    .returning({ id: matches.id, status: matches.status });
  return updated[0] ?? null;
}

// Pull digest candidates: BV/HIGH/MEDIUM in the lookback window, dismissed
// + baseline rows excluded. The actual alert decision happens in
// shouldAlert (lib/fit/score.ts) — MEDIUM rows scoring above the
// alertThreshold pass that filter even though they don't clear the HIGH
// level band. Sort: BV first, HIGH next, MEDIUM last; newest within each.
export async function getRecentAlertCandidates(since: Date): Promise<Match[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        gte(matches.firstSeen, since),
        inArray(matches.level, ["BV", "HIGH", "MEDIUM"]),
        ne(matches.status, "dismissed"),
        eq(matches.isBaseline, false),
      ),
    )
    .orderBy(desc(matches.firstSeen));
  return rows.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

// Return a per-slug set of job IDs currently in the DB. Feeds the diff
// detector: any job ID not already in the set counts as new this run.
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

// Upsert every match from a scan run. New rows get first_seen = last_seen
// = now (DB defaults). Existing rows (same ats + slug + job_id) refresh
// last_seen + updated_at + any drifted fields, but the SET clause
// intentionally omits first_seen + is_baseline — those omissions
// guarantee the discovery timestamp and the baseline flag stay accurate
// to when the role was first detected, not the most recent re-scan.
//
// `baselineSlugs` = the set of slugs whose first-ever scan this is. Their
// rows insert with is_baseline=true so they don't appear as "new" in the
// digest. Rows for slugs already in DB insert with the default (false).
export async function persistScanResults(
  results: CompanyResult[],
  baselineSlugs: Set<string>,
): Promise<void> {
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
  if (rows.length === 0) return;

  const db = getDb();
  await db
    .insert(matches)
    .values(rows)
    .onConflictDoUpdate({
      target: [matches.ats, matches.companySlug, matches.jobId],
      set: {
        lastSeen: sql`now()`,
        updatedAt: sql`now()`,
        // level intentionally NOT overwritten on conflict — classifier
        // rule changes on in-flight rows would require an explicit
        // reclassify; persistScore is the only thing that updates level
        // (to the score-derived bucket).
        title: sql`excluded.title`,
        location: sql`excluded.location`,
        companyDisplayName: sql`excluded.company_display_name`,
      },
    });
}
