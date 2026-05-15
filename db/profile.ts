import { desc, sql } from "drizzle-orm";
import { getDb } from "./client";
import { userProfile, type UserProfile } from "./schema";

// Module-memory cache of the user profile. The profile is read on every
// fit-scoring call and every Pro/Con summary call — round-tripping to
// the DB each time would burn latency on data that only changes when
// the user re-runs `npm run ingest-resume`. The cache resets on every
// cold start (typical Vercel serverless invocation), which is also
// exactly when an updated profile would be re-deployed.
let cached: UserProfile | null = null;

// Returns the user's parsed resume profile, or null if the user_profile
// table is empty (they haven't run ingest-resume yet). Callers should
// handle null gracefully — scoring falls back to a generic prompt that
// says "no candidate profile available; use title + location to score
// industry/seniority neutrally."
export async function getUserProfile(): Promise<UserProfile | null> {
  if (cached) return cached;
  const db = getDb();
  const rows = await db
    .select()
    .from(userProfile)
    .orderBy(desc(userProfile.updatedAt))
    .limit(1);
  cached = rows[0] ?? null;
  return cached;
}

// Return the raw resume markdown (full text — same content as
// docs/resume.md at ingestion time), or null if no profile is loaded.
// Used by the two-tier scoring prompts which interpolate the full
// resume into the system block (cached via Anthropic prompt-caching).
// Hits the same module cache as getUserProfile() so successive calls
// are sub-ms.
export async function getRawResume(): Promise<string | null> {
  const profile = await getUserProfile();
  return profile?.rawResumeMd ?? null;
}

// Replace the single profile row. Used by scripts/ingest-resume.ts.
// Deletes any existing rows first so we always have exactly one row
// representing the most recent ingestion — no version history needed.
export async function replaceUserProfile(row: {
  rawResumeMd: string;
  parsedSummary: string;
  yearsExperience: number | null;
  industries: string[];
  functions: string[];
  seniorityLevel: string | null;
  targetRoles: string[];
  hardExclusions: string[];
}): Promise<UserProfile> {
  const db = getDb();
  await db.delete(userProfile);
  const inserted = await db
    .insert(userProfile)
    .values({
      rawResumeMd: row.rawResumeMd,
      parsedSummary: row.parsedSummary,
      yearsExperience: row.yearsExperience,
      industries: row.industries,
      functions: row.functions,
      seniorityLevel: row.seniorityLevel,
      targetRoles: row.targetRoles,
      hardExclusions: row.hardExclusions,
      updatedAt: sql`now()`,
    })
    .returning();
  cached = inserted[0];
  return cached;
}
