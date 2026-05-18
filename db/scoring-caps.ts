// Per-user cached getter + replacer for the scoring_caps table.
// Phase 5 made this per-user — getScoringCaps now requires userId.
// Each user has their own scoring_caps row (Phase 2 backfill seeded
// the maintainer; new users fall back to FALLBACK_CAPS when no row
// exists, then upsert on first replace).
//
// Note: monthlyCapsUsd inside the returned ScoringCaps is largely
// IGNORED in Phase 5 — the per-user $ cap now derives from
// user_extras.monthly_cap_usd via lib/fit/spendCaps.ts. The other
// fields (perDayCaps, haikuToSonnetThresholds, behaviorOnCapHit)
// are still used for global scan-throughput limits and escalation
// policy.

import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { scoringCaps } from "./schema";
import {
  FALLBACK_CAPS,
  validateCaps,
  type ScoringCaps,
} from "@/lib/config/scoring-caps-types";

// Per-user module-memory cache. Each user's caps are cached
// independently. Cleared on every cold start.
const cache = new Map<string, ScoringCaps>();

export async function getScoringCaps(userId: string): Promise<ScoringCaps> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const db = getDb();
  const rows = await db
    .select({ config: scoringCaps.config })
    .from(scoringCaps)
    .where(eq(scoringCaps.userId, userId))
    .limit(1);
  const config = rows[0]?.config ?? FALLBACK_CAPS;
  cache.set(userId, config);
  return config;
}

// Upsert the caps row for a user. Validates first to avoid persisting
// a nonsense config. Upserts on user_id (UNIQUE constraint added in
// Phase 2). The legacy `key` column stays at 'default' for the
// maintainer's row, and at the user's id for new rows — Phase 7
// cleanup drops the `key` column entirely.
export async function replaceScoringCaps(
  userId: string,
  next: ScoringCaps,
): Promise<ScoringCaps> {
  validateCaps(next);
  const db = getDb();
  await db
    .insert(scoringCaps)
    .values({ key: userId, userId, config: next })
    .onConflictDoUpdate({
      target: scoringCaps.userId,
      set: { config: next, updatedAt: sql`now()` },
    });
  cache.set(userId, next);
  return next;
}

// Test/dev hook: clear the module cache so the next getScoringCaps()
// round-trips to DB.
export function _resetScoringCapsCache(): void {
  cache.clear();
}
