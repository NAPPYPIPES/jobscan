// Fan out global match rows into per-user state. Called from two
// places:
//   - lib/scan/run.ts, after persistScanResults() upserts new matches.
//   - app/api/onboarding/targets/add/route.ts, after a user adds a new
//     target (we backfill their user_matches against the currently-open
//     matches for that target so the dashboard isn't empty).
//
// The same SQL handles both cases. It's idempotent — only inserts
// (user_id, match_id) pairs that don't already exist — so running it
// after every scan with no scoping at all is safe.
//
// is_baseline rule: TRUE if either
//   (a) matches.is_baseline = true — global "first-ever scan of a
//       newly-added target" rows, never surfaced as net-new for anyone
//   (b) matches.first_seen <= user_targets.created_at — the user
//       started watching the target AFTER the match was first seen;
//       from their perspective the row is historical, not net-new
// FALSE otherwise — the user was already watching when the role
// appeared, so it counts as a real "new in the last 24h" alert.

import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

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
): Promise<{ inserted: number }> {
  const db = getDb();

  // We can't parameterize identifiers, but the filter predicates take
  // bind parameters happily. Build a WHERE clause that's a no-op
  // when scope is empty and tightens to a specific (user, slug) pair
  // otherwise.
  const userFilter = scope.userId ? sql` AND ut.user_id = ${scope.userId}` : sql``;
  const slugFilter = scope.targetSlug ? sql` AND ut.target_slug = ${scope.targetSlug}` : sql``;

  const result = await db.execute(sql`
    INSERT INTO user_matches (
      user_id, match_id, level, status, is_baseline
    )
    SELECT
      ut.user_id,
      m.id,
      m.level,
      'new',
      (m.is_baseline OR m.first_seen <= ut.created_at)
    FROM user_targets ut
    JOIN matches m ON m.company_slug = ut.target_slug
    WHERE m.closed_at IS NULL
      ${userFilter}
      ${slugFilter}
      AND NOT EXISTS (
        SELECT 1 FROM user_matches um
        WHERE um.user_id = ut.user_id
          AND um.match_id = m.id
      )
  `);

  // neon-http returns rowCount on the execute result. Type-cast via
  // `unknown` since the lib's typing is loose on this shape.
  const inserted = (result as unknown as { rowCount?: number; rows?: unknown[] }).rowCount ?? 0;
  return { inserted };
}
