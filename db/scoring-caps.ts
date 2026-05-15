// Cached getter + replacer for the scoring_caps table. Single row keyed
// on 'default' (single-user app, matches user_profile's pattern). The
// running app reads only from DB — config/scoring-caps.json is ingest
// seed only, written here by scripts/ingest-config.ts and by the
// /docs Settings UI server action.
//
// Mirrors db/profile.ts (cached getter + transactional replacer) but
// uses the upsert-then-prune pattern from db/personal-keywords.ts since
// neon-http doesn't support multi-statement transactions. For the
// single-row case it's effectively just an upsert — no prune needed
// because there's exactly one key ('default').

import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { scoringCaps } from "./schema";
import {
  FALLBACK_CAPS,
  validateCaps,
  type ScoringCaps,
} from "@/lib/config/scoring-caps-types";

// Module-memory cache. Cleared on every cold start (Vercel function
// re-init) which is also when freshly-ingested caps would take effect
// for a user who ran `npm run ingest-config`. The /docs server action
// also writes here directly via replaceScoringCaps, so saves in the UI
// reflect on the next request from the same warm container.
let cached: ScoringCaps | null = null;

// Returns the user's scoring caps, falling back to FALLBACK_CAPS when
// the table is empty (fresh install before first `ingest-config`). The
// FALLBACK is intentional: a forker should be able to spin up the repo
// and have the scanner work with sane defaults, even before they edit
// or ingest their own caps. The empty-config guardrail in run.ts only
// fires for `targets` (the workhorse table) — caps absence is fine.
export async function getScoringCaps(): Promise<ScoringCaps> {
  if (cached) return cached;
  const db = getDb();
  const rows = await db
    .select({ config: scoringCaps.config })
    .from(scoringCaps)
    .where(eq(scoringCaps.key, "default"))
    .limit(1);
  cached = rows[0]?.config ?? FALLBACK_CAPS;
  return cached;
}

// Replace the single caps row. Validates first to avoid persisting a
// nonsense config (e.g. typo'd $200 total cap). On success, updates the
// module cache so the same warm container reflects the new values
// without a re-fetch. Called by scripts/ingest-config.ts and by the
// /docs Settings UI server action.
export async function replaceScoringCaps(
  next: ScoringCaps,
): Promise<ScoringCaps> {
  validateCaps(next);
  const db = getDb();
  await db
    .insert(scoringCaps)
    .values({ key: "default", config: next })
    .onConflictDoUpdate({
      target: scoringCaps.key,
      set: { config: next, updatedAt: sql`now()` },
    });
  cached = next;
  return cached;
}

// Test/dev hook: clear the module cache so the next getScoringCaps()
// round-trips to DB. Exposed for tests and for the unlikely case where
// the DB row is mutated out-of-band.
export function _resetScoringCapsCache(): void {
  cached = null;
}
