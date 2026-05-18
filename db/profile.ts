import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { userProfile, type UserProfile } from "./schema";
import { MAINTAINER_USER_ID } from "@/lib/auth/maintainer";

// Per-user resume cache. The profile is read on every fit-scoring
// call and every Pro/Con summary call — round-tripping to the DB
// each time would burn latency on data that only changes when the
// user re-runs `npm run ingest-resume` or re-saves through the
// onboarding wizard. Keyed by user_id so multiple signed-in users
// share the same module-memory map without poisoning each other.
const cache = new Map<string, UserProfile>();

// Returns the user's parsed resume profile, or null if no row exists
// yet for that user. Callers handle null gracefully — scoring falls
// back to a generic prompt that says "no candidate profile available;
// use title + location to score industry/seniority neutrally."
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const db = getDb();
  const rows = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, userId))
    .limit(1);
  const row = rows[0] ?? null;
  if (row) cache.set(userId, row);
  return row;
}

// Return the raw resume markdown (full text — same content the user
// pasted at onboarding or wrote in docs/resume.md). Null if no profile
// exists for that user. Used by the two-tier scoring prompts which
// interpolate the full resume into the system block (cached via
// Anthropic prompt-caching).
export async function getRawResume(userId: string): Promise<string | null> {
  const profile = await getUserProfile(userId);
  return profile?.rawResumeMd ?? null;
}

// Upsert a user's profile row. Used by:
//   - scripts/ingest-resume.ts (maintainer, CLI flow)
//   - app/api/onboarding/resume/route.ts (new user, wizard flow)
//
// user_id is UNIQUE in the schema, so onConflict(userId) doUpdate
// gives us idempotent re-runs and "edit my resume after onboarding"
// for free.
export async function replaceUserProfile(
  userId: string,
  row: {
    rawResumeMd: string;
    parsedSummary: string;
    yearsExperience: number | null;
    industries: string[];
    functions: string[];
    seniorityLevel: string | null;
    targetRoles: string[];
    hardExclusions: string[];
  },
): Promise<UserProfile> {
  const db = getDb();
  const inserted = await db
    .insert(userProfile)
    .values({
      userId,
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
    .onConflictDoUpdate({
      target: userProfile.userId,
      set: {
        rawResumeMd: row.rawResumeMd,
        parsedSummary: row.parsedSummary,
        yearsExperience: row.yearsExperience,
        industries: row.industries,
        functions: row.functions,
        seniorityLevel: row.seniorityLevel,
        targetRoles: row.targetRoles,
        hardExclusions: row.hardExclusions,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const saved = inserted[0];
  if (!saved) throw new Error("replaceUserProfile: insert returned no rows");
  cache.set(userId, saved);
  return saved;
}

// Phase 2-4 stopgap: scoring + summary code still scores against the
// maintainer's profile (the only user with active scoring during the
// cutover). Phase 5 wires getViewerUserId() through these helpers.
export const MAINTAINER_PROFILE_USER_ID = MAINTAINER_USER_ID;
