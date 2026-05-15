// One-shot migration runner for drizzle/0002_two_tier_scoring.sql.
// Adds the Tier-1 columns to matches, the pending_bv_verification flag,
// bv_reasoning, and the scoring_caps table. Idempotent — re-runs are
// safe.
//
// Usage: npx tsx scripts/apply-migration-0002.ts
//
// Same neon-http pattern as scripts/apply-migration-0001.ts: drizzle-kit
// migrate prefers connection-based drivers, but the running app uses
// neon-http, so we apply via the same client to keep the auth path
// identical to runtime.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

  console.log("Applying migration 0002: two-tier scoring (idempotent)…");

  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_score" numeric(3, 1)`;
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_confidence" text`;
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_is_potential_bv" boolean`;
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_quick_take" text`;
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "pending_bv_verification" boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "bv_reasoning" text`;
  await sql`
    CREATE TABLE IF NOT EXISTS "scoring_caps" (
      "key" text PRIMARY KEY DEFAULT 'default',
      "config" jsonb NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `;

  // Verification: every new column + table is present.
  const cols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'matches'
      AND column_name IN ('tier1_score','tier1_confidence','tier1_is_potential_bv','tier1_quick_take','pending_bv_verification','bv_reasoning')
    ORDER BY column_name
  `;
  const scoringCapsTable = await sql`
    SELECT to_regclass('scoring_caps') AS reg
  `;

  console.log("matches new columns:", cols.map((r) => r.column_name).join(", "));
  console.log("scoring_caps table:", scoringCapsTable[0]?.reg);

  if (cols.length !== 6 || scoringCapsTable[0]?.reg === null) {
    throw new Error("Verification failed — at least one column or table is missing.");
  }
  console.log("Migration 0002 applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
