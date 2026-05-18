import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { userExtras, type UserExtras } from "./schema";

// Per-user app state — kept in user_extras (one-to-one with NextAuth's
// `users` table). The onboarding flag lives here; so does the per-user
// monthly cap that Phase 5 will read in the scoring path.

export async function getUserExtras(userId: string): Promise<UserExtras | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(userExtras)
    .where(eq(userExtras.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

// Marks the user as onboarded. Idempotent (a re-call just refreshes
// updatedAt). Layout reads onboardingCompletedAt; non-null = done.
export async function markOnboardingComplete(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(userExtras)
    .set({ onboardingCompletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(userExtras.userId, userId));
}

// Saves the user's preferred digest email + on/off toggle. Called on
// the last step of the onboarding wizard. Email defaults to the
// user's auth email, but a friend who wants notifications at a
// different inbox can override here.
export async function setDigestPreferences(
  userId: string,
  prefs: { digestEnabled: boolean; digestEmail: string | null },
): Promise<void> {
  const db = getDb();
  await db
    .update(userExtras)
    .set({
      digestEnabled: prefs.digestEnabled,
      digestEmail: prefs.digestEmail,
      updatedAt: sql`now()`,
    })
    .where(eq(userExtras.userId, userId));
}

// Phase 3 onboarding inserts the row for a new email/password user if
// /api/auth/register hasn't already done it (it does, currently). Kept
// here as a safety net so the layout's onboarding redirect can recover
// from any race / stale-account state without crashing.
export async function ensureUserExtras(
  userId: string,
  defaults?: { digestEmail?: string | null },
): Promise<void> {
  const db = getDb();
  await db
    .insert(userExtras)
    .values({
      userId,
      digestEmail: defaults?.digestEmail ?? null,
    })
    .onConflictDoNothing();
}
