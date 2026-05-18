// Deterministic UUIDs for the two seeded accounts. Hardcoded so dev
// and prod DBs converge and so per-user backfills / lookups stay
// idempotent across environments.
//
// On first Google sign-in the NextAuth Drizzle adapter links the
// OAuth account to the pre-seeded maintainer row by email match
// (allowDangerousEmailAccountLinking=true) instead of creating a
// duplicate users row.
export const MAINTAINER_USER_ID = "00000000-0000-0000-0000-000000000001";

// Maintainer email is sourced from env so forks can be deployed
// without editing this file. Local: set MAINTAINER_EMAIL in
// .env.local. Vercel: set it in the project's environment variables.
// The .local fallback is a deliberately non-resolving placeholder —
// if you ever see this address in a sent email or DB row, it means
// MAINTAINER_EMAIL wasn't configured at migration time.
export const MAINTAINER_EMAIL =
  process.env.MAINTAINER_EMAIL ?? "maintainer@pub-ats-radar.local";

// The demo user. Authenticated via the no-credentials "demo" NextAuth
// provider in lib/auth/config.ts — clicking "Try the demo" on /login
// signs anyone in as this account. Cap is $0 (no AI spend) and
// onboarding is pre-completed (no wizard). Mutation routes block via
// requireOwner() so the demo user can't corrupt shared data.
export const DEMO_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEMO_EMAIL = "demo@pub-ats-radar.local";

export function isMaintainer(userId: string | null | undefined): boolean {
  return userId === MAINTAINER_USER_ID;
}

export function isDemoUser(userId: string | null | undefined): boolean {
  return userId === DEMO_USER_ID;
}
