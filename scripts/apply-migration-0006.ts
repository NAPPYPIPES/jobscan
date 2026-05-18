// One-shot migration runner for Phase 4 of the multi-user migration.
//
// 1. Adds user_matches.is_baseline (default false) — per-user baseline
//    flag so adding a new target doesn't flood the user with "100 new
//    roles" the first time.
// 2. Backfills maintainer's user_matches.is_baseline from
//    matches.is_baseline (his existing baseline-on-insert behaviour
//    carries forward to the per-user table).
// 3. Seeds the demo user's user_targets / user_manual_companies from
//    the curated DEMO_SLUGS_ARRAY (lib/auth/demo-allowlist.ts), and
//    seeds demo user_matches by copying the maintainer's per-user
//    state for those slugs as a "fresh visitor" view (status='new',
//    nothing applied/dismissed, but inherits Claude fit scores so the
//    demo benefits from prior scoring spend).
//
// Idempotent: ON CONFLICT DO NOTHING / IF NOT EXISTS everywhere.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { MAINTAINER_USER_ID, DEMO_USER_ID } from "../lib/auth/maintainer";
import { DEMO_SLUGS_ARRAY } from "../lib/auth/demo-allowlist";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

  console.log("Applying migration 0006: user_matches.is_baseline + demo seed (idempotent)…");

  // ── Add the column ──────────────────────────────────────────────────
  await sql`
    ALTER TABLE "user_matches"
    ADD COLUMN IF NOT EXISTS "is_baseline" boolean NOT NULL DEFAULT false
  `;

  // ── Backfill maintainer's is_baseline from matches ──────────────────
  // Only flips rows that are currently false (the default) — re-runs
  // are no-ops once the backfill has landed.
  await sql`
    UPDATE "user_matches" um
    SET "is_baseline" = m."is_baseline"
    FROM "matches" m
    WHERE um."match_id" = m."id"
      AND um."user_id" = ${MAINTAINER_USER_ID}
      AND um."is_baseline" = false
      AND m."is_baseline" = true
  `;

  // ── Seed demo user_targets from DEMO_SLUGS ──────────────────────────
  // Only inserts slugs that exist in the live `targets` table — the
  // INNER JOIN drops curated slugs we don't actually track.
  const demoSlugsJson = JSON.stringify(DEMO_SLUGS_ARRAY);
  await sql`
    INSERT INTO "user_targets" ("user_id", "target_slug")
    SELECT ${DEMO_USER_ID}, t.slug
    FROM "targets" t
    WHERE t.slug = ANY(SELECT jsonb_array_elements_text(${demoSlugsJson}::jsonb))
    ON CONFLICT ("user_id", "target_slug") DO NOTHING
  `;

  // ── Seed demo user_manual_companies ─────────────────────────────────
  // Demo gets all globally-known manual companies — Meta/Amazon/Google
  // are the marquee examples the wizard's upsell highlights, so showing
  // them on /manual is on-message.
  await sql`
    INSERT INTO "user_manual_companies" ("user_id", "manual_company_name")
    SELECT ${DEMO_USER_ID}, mc."name" FROM "manual_companies" mc
    ON CONFLICT ("user_id", "manual_company_name") DO NOTHING
  `;

  // ── Seed demo user_matches ──────────────────────────────────────────
  // Copies the maintainer's per-user state for the curated slugs, but
  // resets status to 'new' (a demo visitor shouldn't see maintainer's
  // applied/dismissed history). fit_score / fit_summary / tier1_* /
  // level / bv_reasoning are preserved so the demo benefits from
  // existing Claude scoring without re-running it.
  //
  // is_baseline propagates from the maintainer's row so the same
  // "added-this-target-yesterday" flag treatment carries through.
  await sql`
    INSERT INTO "user_matches" (
      "user_id", "match_id", "level", "status",
      "applied_at", "dismissed_at", "dismiss_reason",
      "fit_score", "fit_summary", "fit_flag",
      "tier1_score", "tier1_confidence", "tier1_is_potential_bv", "tier1_quick_take",
      "pending_bv_verification", "bv_reasoning", "is_baseline"
    )
    SELECT
      ${DEMO_USER_ID}, um."match_id", um."level", 'new',
      NULL, NULL, NULL,
      um."fit_score", um."fit_summary", um."fit_flag",
      um."tier1_score", um."tier1_confidence", um."tier1_is_potential_bv", um."tier1_quick_take",
      false, um."bv_reasoning", um."is_baseline"
    FROM "user_matches" um
    JOIN "matches" m ON m."id" = um."match_id"
    WHERE um."user_id" = ${MAINTAINER_USER_ID}
      AND m."closed_at" IS NULL
      AND m."company_slug" = ANY(SELECT jsonb_array_elements_text(${demoSlugsJson}::jsonb))
    ON CONFLICT ("user_id", "match_id") DO NOTHING
  `;

  // ── Verification ────────────────────────────────────────────────────
  const counts = await sql`
    SELECT
      (SELECT count(*) FROM user_matches WHERE user_id = ${MAINTAINER_USER_ID} AND is_baseline = true) AS maint_baseline,
      (SELECT count(*) FROM user_targets WHERE user_id = ${DEMO_USER_ID}) AS demo_targets,
      (SELECT count(*) FROM user_manual_companies WHERE user_id = ${DEMO_USER_ID}) AS demo_manual,
      (SELECT count(*) FROM user_matches WHERE user_id = ${DEMO_USER_ID}) AS demo_matches
  `;

  console.log("\nMigration counts:");
  console.log(counts[0]);
  console.log("\nMigration 0006 applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
