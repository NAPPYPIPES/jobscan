// One-shot migration runner for the NextAuth + multi-user foundation.
// Creates the four Auth.js tables (users, accounts, sessions,
// verification_tokens) + user_extras, then seeds the maintainer row
// with a deterministic UUID so dev and prod converge.
//
// Idempotent: re-runs are safe. ON CONFLICT DO NOTHING on the seed
// insert, CREATE TABLE IF NOT EXISTS everywhere.
//
// Usage: npx tsx scripts/apply-migration-0003.ts
//
// Same neon-http pattern as scripts/apply-migration-0002.ts: one
// statement per call, no transaction wrapping (neon-http doesn't
// support multi-statement transactions).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { MAINTAINER_USER_ID, MAINTAINER_EMAIL } from "../lib/auth/maintainer";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

  console.log("Applying migration 0003: NextAuth tables + maintainer seed (idempotent)…");

  // ── NextAuth tables (Auth.js Drizzle adapter shape) ─────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" text,
      "email" text NOT NULL UNIQUE,
      "email_verified" timestamp with time zone,
      "image" text
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "accounts" (
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "type" text NOT NULL,
      "provider" text NOT NULL,
      "provider_account_id" text NOT NULL,
      "refresh_token" text,
      "access_token" text,
      "expires_at" integer,
      "token_type" text,
      "scope" text,
      "id_token" text,
      "session_state" text,
      PRIMARY KEY ("provider", "provider_account_id")
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "sessions" (
      "session_token" text PRIMARY KEY,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "expires" timestamp with time zone NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "verification_tokens" (
      "identifier" text NOT NULL,
      "token" text NOT NULL,
      "expires" timestamp with time zone NOT NULL,
      PRIMARY KEY ("identifier", "token")
    )
  `;

  // ── App-specific per-user state ─────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS "user_extras" (
      "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
      "password_hash" text,
      "monthly_cap_usd" numeric(8, 2) NOT NULL DEFAULT 5.00,
      "is_maintainer" boolean NOT NULL DEFAULT false,
      "digest_enabled" boolean NOT NULL DEFAULT true,
      "digest_email" text,
      "onboarding_completed_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `;

  // ── Seed maintainer ─────────────────────────────────────────────────
  // Deterministic UUID so dev/prod converge and so future per-user
  // backfills (migration 0004+) can reference this id directly.
  await sql`
    INSERT INTO "users" ("id", "email", "name", "email_verified")
    VALUES (${MAINTAINER_USER_ID}, ${MAINTAINER_EMAIL}, 'Luke Murphy', now())
    ON CONFLICT ("id") DO NOTHING
  `;

  // Maintainer's cap is 999.00 (effectively unlimited) so per-user
  // enforcement doesn't change current single-user behavior. Onboarding
  // is pre-completed for the maintainer.
  await sql`
    INSERT INTO "user_extras" (
      "user_id", "monthly_cap_usd", "is_maintainer",
      "digest_enabled", "digest_email", "onboarding_completed_at"
    )
    VALUES (
      ${MAINTAINER_USER_ID}, 999.00, true,
      true, ${MAINTAINER_EMAIL}, now()
    )
    ON CONFLICT ("user_id") DO NOTHING
  `;

  // ── Verification ────────────────────────────────────────────────────
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users', 'accounts', 'sessions', 'verification_tokens', 'user_extras')
    ORDER BY table_name
  `;
  const maintainerRow = await sql`
    SELECT u.id, u.email, ue.is_maintainer, ue.monthly_cap_usd
    FROM "users" u
    JOIN "user_extras" ue ON ue.user_id = u.id
    WHERE u.id = ${MAINTAINER_USER_ID}
  `;

  console.log("Tables present:", tables.map((r) => r.table_name).join(", "));
  console.log("Maintainer row:", maintainerRow[0]);

  if (tables.length !== 5) {
    throw new Error(`Verification failed — expected 5 auth tables, got ${tables.length}.`);
  }
  if (maintainerRow.length !== 1) {
    throw new Error("Verification failed — maintainer row missing.");
  }
  console.log("Migration 0003 applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
