// Fan out global match rows into per-user state. Called from two
// places:
//   - lib/scan/run.ts, after persistScanResults() upserts new matches.
//     Passes a `levelByMatchId` map populated from the in-memory
//     classifier output for every match the scan just touched.
//   - app/api/onboarding/targets/add/route.ts, after a user adds a new
//     target. No map — backfills against currently-open matches and
//     sources `level` from any other user's existing user_matches row
//     for the same match (level is a function of (match, classifier
//     vocab) and today the classifier vocab is global, so reusing
//     another user's level is accurate).
//
// Phase 7 dropped matches.level, so the SQL can no longer read it
// from `m.*` — hence the two code paths below. The previous single-
// query version did `SELECT m.level FROM matches m`, which now 500s.
//
// is_baseline rule (both paths): TRUE if either
//   (a) matches.is_baseline = true — global "first-ever scan of a
//       newly-added target" rows, never surfaced as net-new for anyone
//   (b) matches.first_seen <= user_targets.created_at — the user
//       started watching the target AFTER the match was first seen;
//       from their perspective the row is historical, not net-new
// FALSE otherwise — the user was already watching when the role
// appeared, so it counts as a real "new in the last 24h" alert.

import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import type { Level } from "@/lib/scan/types";

export type FanOutScope = {
  // Restrict to a single user. Used by the onboarding add-target
  // route — we know exactly which user just added a target so a
  // global scan is wasteful.
  userId?: string;
  // Restrict to a single target slug. Same use case.
  targetSlug?: string;
};

export async function fanOutToUserMatches(
  scope: FanOutScope = {},
  levelByMatchId?: Map<string, Level>,
): Promise<{ inserted: number }> {
  const db = getDb();

  // We can't parameterize identifiers, but the filter predicates take
  // bind parameters happily. Build a WHERE clause that's a no-op
  // when scope is empty and tightens to a specific (user, slug) pair
  // otherwise.
  const userFilter = scope.userId ? sql` AND ut.user_id = ${scope.userId}` : sql``;
  const slugFilter = scope.targetSlug ? sql` AND ut.target_slug = ${scope.targetSlug}` : sql``;

  // Scan-time path: caller supplied a (matchId → level) map from the
  // classifier output. Use a VALUES CTE so every newly-fanned-out row
  // gets the freshly-classified level. A defined-but-empty map means
  // "scan ran, no matches touched" — skip entirely rather than fall
  // through to the backfill path (which would do an expensive
  // unscoped no-op).
  if (levelByMatchId !== undefined && levelByMatchId.size === 0) {
    return { inserted: 0 };
  }
  if (levelByMatchId && levelByMatchId.size > 0) {
    const entries = [...levelByMatchId.entries()];
    const valuesSql = sql.join(
      entries.map(([id, level]) => sql`(${id}::uuid, ${level}::text)`),
      sql`, `,
    );
    const result = await db.execute(sql`
      WITH new_levels(match_id, level) AS (
        VALUES ${valuesSql}
      )
      INSERT INTO user_matches (
        user_id, match_id, level, status, is_baseline
      )
      SELECT
        ut.user_id,
        m.id,
        nl.level,
        'new',
        (m.is_baseline OR m.first_seen <= ut.created_at)
      FROM user_targets ut
      JOIN matches m ON m.company_slug = ut.target_slug
      JOIN new_levels nl ON nl.match_id = m.id
      WHERE m.closed_at IS NULL
        ${userFilter}
        ${slugFilter}
        AND NOT EXISTS (
          SELECT 1 FROM user_matches um
          WHERE um.user_id = ut.user_id
            AND um.match_id = m.id
        )
    `);
    const inserted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    return { inserted };
  }

  // Backfill path (onboarding adds a target, or a manual call with no
  // map). Source level from any existing user_matches row for the same
  // match via correlated subquery; skip rows with no existing level so
  // we don't violate user_matches.level NOT NULL. Matches that no one
  // has classified yet will be picked up by the next scan's fan-out
  // with the freshly-classified level.
  const result = await db.execute(sql`
    INSERT INTO user_matches (
      user_id, match_id, level, status, is_baseline
    )
    SELECT
      ut.user_id,
      m.id,
      (SELECT level FROM user_matches um2 WHERE um2.match_id = m.id LIMIT 1),
      'new',
      (m.is_baseline OR m.first_seen <= ut.created_at)
    FROM user_targets ut
    JOIN matches m ON m.company_slug = ut.target_slug
    WHERE m.closed_at IS NULL
      ${userFilter}
      ${slugFilter}
      AND EXISTS (
        SELECT 1 FROM user_matches um3 WHERE um3.match_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_matches um
        WHERE um.user_id = ut.user_id
          AND um.match_id = m.id
      )
  `);

  const inserted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  return { inserted };
}
