import { and, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { matches, targets } from "./schema";
import { LEVEL_ORDER, type CompanyResult } from "@/lib/scan/types";
import type { Match, MatchStatus } from "./schema";
import { DEMO_SLUGS_ARRAY } from "@/lib/auth/demo-allowlist";
import type { Role } from "@/lib/auth/cookie";

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
    // Demo viewers see only the curated subset of slugs. Owner mode
    // (default) sees all 133. The DB stores rows for every company
    // — filtering is purely at read time.
    role?: Role;
  } = {},
): Promise<Match[]> {
  const db = getDb();
  // closed_at IS NULL is the new default — closed rows (scanner saw
  // them lapse from the ATS) shouldn't appear in /all or /. The
  // analytics "Likely closed" widget reads closed_at IS NOT NULL
  // directly; nothing else should need to opt back in.
  const conditions = [ne(matches.status, "dismissed"), isNull(matches.closedAt)];
  if (opts.excludeApplied) conditions.push(ne(matches.status, "applied"));
  if (opts.excludeBaseline) conditions.push(eq(matches.isBaseline, false));
  if (opts.role === "demo") {
    conditions.push(inArray(matches.companySlug, DEMO_SLUGS_ARRAY as string[]));
  }
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
        isNull(matches.closedAt),
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

// Upsert every match from a scan run AND actively close any prior row
// for a successful slug whose jobId wasn't returned this run. Only
// successful slugs (those present in `results`) trigger closure —
// failed-fetch slugs are skipped entirely so a transient ATS outage
// doesn't auto-close every match for that company.
//
// New rows get first_seen = last_seen = now (DB defaults). Existing
// rows (same ats + slug + job_id) refresh last_seen + updated_at +
// drifted fields AND clear closed_at (a re-appearing job ID means the
// listing reopened — rare, but happens). The SET clause intentionally
// omits first_seen + is_baseline so the discovery timestamp and the
// baseline flag stay accurate to when the role was first detected.
//
// `baselineSlugs` = slugs whose first-ever scan this is. Their rows
// insert with is_baseline=true so they don't appear as "new" in the
// digest. Rows for slugs already in DB insert with the default (false).
//
// After upsert + closure, writes targets.last_success_at = now() for
// every successful slug. Brand-new targets that haven't yet scanned
// once read as last_success_at IS NULL, distinguishable from "scanned
// recently but currently failing."
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
          // level intentionally NOT overwritten on conflict — classifier
          // rule changes on in-flight rows would require an explicit
          // reclassify; persistScore is the only thing that updates level
          // (to the score-derived bucket).
          title: sql`excluded.title`,
          location: sql`excluded.location`,
          companyDisplayName: sql`excluded.company_display_name`,
          // Reopen: if a previously-closed job ID reappears, the
          // listing is back up. Clear the timestamp so the row drops
          // out of the closed-roles widget and back into /all.
          closedAt: sql`NULL`,
        },
      });
  }

  // Per-slug closure pass. For each successful slug, mark every
  // currently-active match (closed_at IS NULL) whose job_id isn't in
  // the just-scanned set as closed.
  //
  // The empty-jobs case (scan succeeded but returned zero jobs) is a
  // legitimate "company has no postings right now" signal and all
  // prior open rows for that slug should close. Drizzle's
  // notInArray() returns FALSE for an empty array (it can't generate
  // `NOT IN ()`), so we branch: no jobs ⇒ close all active rows; some
  // jobs ⇒ close rows not in the set.
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

  // Stamp last_success_at on every target whose scan succeeded. One
  // batched UPDATE — cheap even with 130+ slugs.
  if (successfulSlugs.length > 0) {
    await db
      .update(targets)
      .set({ lastSuccessAt: sql`now()` })
      .where(inArray(targets.slug, successfulSlugs));
  }
}
