// One-shot migration runner to seed the demo user. Restores the
// "click-through demo" UX from the pre-multi-user codebase but with no
// password — the /login page has a "Try the demo" button that signs
// anyone in as this user via the no-credentials NextAuth "demo"
// provider (lib/auth/config.ts).
//
// The demo user has:
//   - monthly_cap_usd = 0.00          → all AI scoring calls are blocked
//   - onboarding_completed_at = now() → skips the wizard
//   - digest_enabled = false          → no email
//   - is_maintainer = false
//
// Because Phase 4-6 hasn't moved the read paths to user_matches yet,
// the demo user sees the maintainer's full dataset (single-tenant
// reads). Phase 4 will seed a curated subset of user_matches for the
// demo user.
//
// Idempotent: ON CONFLICT DO NOTHING on the seed. Safe to re-run.
//
// Usage: npx tsx scripts/apply-migration-0005.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { DEMO_USER_ID, DEMO_EMAIL } from "../lib/auth/maintainer";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

  console.log("Applying migration 0005: seed demo user (idempotent)…");

  await sql`
    INSERT INTO "users" ("id", "email", "name", "email_verified")
    VALUES (${DEMO_USER_ID}, ${DEMO_EMAIL}, 'Demo', now())
    ON CONFLICT ("id") DO NOTHING
  `;

  await sql`
    INSERT INTO "user_extras" (
      "user_id", "monthly_cap_usd", "is_maintainer",
      "digest_enabled", "digest_email", "onboarding_completed_at"
    )
    VALUES (
      ${DEMO_USER_ID}, 0.00, false,
      false, null, now()
    )
    ON CONFLICT ("user_id") DO NOTHING
  `;

  const row = await sql`
    SELECT u.id, u.email, ue.is_maintainer, ue.monthly_cap_usd, ue.onboarding_completed_at
    FROM "users" u
    JOIN "user_extras" ue ON ue.user_id = u.id
    WHERE u.id = ${DEMO_USER_ID}
  `;

  console.log("Demo row:", row[0]);

  if (row.length !== 1) {
    throw new Error("Verification failed — demo row missing.");
  }
  console.log("Migration 0005 applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
