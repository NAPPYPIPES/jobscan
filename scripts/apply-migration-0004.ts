// One-shot migration runner for Phase 2 of the multi-user migration.
// Creates the new tenant-scoped tables (user_targets, user_manual_
// companies, user_matches, ats_catalog, target_requests) and adds a
// user_id column to every per-user existing table — apiUsage,
// manualChecks, userProfile, personalKeywords, roleSummaries,
// scoringCaps — plus an added_by_user_id attribution column on
// targets. Existing rows are backfilled to the maintainer's
// deterministic UUID.
//
// PKs / unique constraints on the legacy tables are NOT changed here.
// scoringCaps still has key='default' as PK, roleSummaries still has
// match_id as PK, manualChecks still has the (company, check_date)
// uniqueness. Phase 5 swaps those when the helper modules
// (db/scoring-caps.ts, db/profile.ts, etc.) are rewritten to take
// userId as a parameter. Keeping Phase 2 fully additive means the
// app keeps working with no code changes beyond the small stopgap
// passing of MAINTAINER_USER_ID at every insert site.
//
// Idempotent: every step uses IF NOT EXISTS, ON CONFLICT DO NOTHING,
// or a DO-block existence check. Re-runs are safe.
//
// Usage: npx tsx scripts/apply-migration-0004.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { MAINTAINER_USER_ID } from "../lib/auth/maintainer";

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Curated giants with custom careers sites — no public ATS API. When
// a new user types "Google" or "Meta" during onboarding, the catalog
// steers them to add as a manual check-in instead of trying to scan.
const GIANTS: Array<{ canonical: string; url: string }> = [
  { canonical: "Google", url: "https://careers.google.com/jobs/" },
  { canonical: "Meta", url: "https://www.metacareers.com/jobs" },
  { canonical: "Amazon", url: "https://www.amazon.jobs/" },
  { canonical: "Apple", url: "https://jobs.apple.com/" },
  { canonical: "Microsoft", url: "https://careers.microsoft.com/" },
  { canonical: "Netflix", url: "https://jobs.netflix.com/" },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

  console.log("Applying migration 0004: multi-tenant tables + user_id backfill (idempotent)…");

  // ── New tables ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS "user_targets" (
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "target_slug" text NOT NULL REFERENCES "targets"("slug") ON DELETE CASCADE,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id", "target_slug")
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "user_targets_target_idx" ON "user_targets" ("target_slug")`;

  await sql`
    CREATE TABLE IF NOT EXISTS "user_manual_companies" (
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "manual_company_name" text NOT NULL REFERENCES "manual_companies"("name") ON DELETE CASCADE,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id", "manual_company_name")
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "user_matches" (
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "match_id" uuid NOT NULL REFERENCES "matches"("id") ON DELETE CASCADE,
      "level" text NOT NULL,
      "status" text NOT NULL DEFAULT 'new',
      "applied_at" timestamp with time zone,
      "dismissed_at" timestamp with time zone,
      "dismiss_reason" text[],
      "fit_score" numeric(3, 1),
      "fit_summary" text,
      "fit_flag" text,
      "tier1_score" numeric(3, 1),
      "tier1_confidence" text,
      "tier1_is_potential_bv" boolean,
      "tier1_quick_take" text,
      "pending_bv_verification" boolean NOT NULL DEFAULT false,
      "bv_reasoning" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("user_id", "match_id")
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "user_matches_user_status_idx" ON "user_matches" ("user_id", "status")`;
  await sql`CREATE INDEX IF NOT EXISTS "user_matches_user_level_idx" ON "user_matches" ("user_id", "level")`;

  await sql`
    CREATE TABLE IF NOT EXISTS "ats_catalog" (
      "normalized_name" text PRIMARY KEY,
      "canonical_name" text NOT NULL,
      "ats" text NOT NULL,
      "slug" text,
      "careers_url" text,
      "supported" boolean NOT NULL DEFAULT false,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS "target_requests" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "query" text NOT NULL,
      "requested_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS "target_requests_user_idx" ON "target_requests" ("user_id")`;

  // ── Add user_id columns to existing tables (nullable initially) ─────
  await sql`ALTER TABLE "api_usage" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "manual_checks" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "user_profile" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "personal_keywords" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "role_summaries" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "scoring_caps" ADD COLUMN IF NOT EXISTS "user_id" uuid`;
  await sql`ALTER TABLE "targets" ADD COLUMN IF NOT EXISTS "added_by_user_id" uuid`;

  // ── Backfill maintainer's user_id on existing rows ──────────────────
  await sql`UPDATE "api_usage" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "manual_checks" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "user_profile" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "personal_keywords" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "role_summaries" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "scoring_caps" SET "user_id" = ${MAINTAINER_USER_ID} WHERE "user_id" IS NULL`;
  await sql`UPDATE "targets" SET "added_by_user_id" = ${MAINTAINER_USER_ID} WHERE "added_by_user_id" IS NULL`;

  // ── SET NOT NULL on user_id (idempotent: no-op if already NOT NULL) ─
  await sql`ALTER TABLE "api_usage" ALTER COLUMN "user_id" SET NOT NULL`;
  await sql`ALTER TABLE "manual_checks" ALTER COLUMN "user_id" SET NOT NULL`;
  await sql`ALTER TABLE "user_profile" ALTER COLUMN "user_id" SET NOT NULL`;
  await sql`ALTER TABLE "personal_keywords" ALTER COLUMN "user_id" SET NOT NULL`;
  await sql`ALTER TABLE "role_summaries" ALTER COLUMN "user_id" SET NOT NULL`;
  await sql`ALTER TABLE "scoring_caps" ALTER COLUMN "user_id" SET NOT NULL`;
  // targets.added_by_user_id stays nullable (attribution only).

  // ── Add FK constraints (guarded via pg_constraint check) ────────────
  // Postgres ALTER TABLE ADD CONSTRAINT lacks IF NOT EXISTS for FKs
  // before v17 wide deployment. neon-http doesn't allow parameters
  // inside a plpgsql DO block, so we check first via a parameterized
  // SELECT and then run the un-parameterized ALTER (identifiers come
  // from this script's own code — fully trusted, no injection risk).
  const addFk = async (
    table: string,
    column: string,
    constraintName: string,
    onDelete: "CASCADE" | "SET NULL",
  ): Promise<void> => {
    const existing = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = ${constraintName}
    `;
    if (existing.length > 0) return;
    await sql.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}" FOREIGN KEY ("${column}") REFERENCES "users"("id") ON DELETE ${onDelete}`,
    );
  };

  await addFk("api_usage", "user_id", "api_usage_user_id_fk", "CASCADE");
  await addFk("manual_checks", "user_id", "manual_checks_user_id_fk", "CASCADE");
  await addFk("user_profile", "user_id", "user_profile_user_id_fk", "CASCADE");
  await addFk("personal_keywords", "user_id", "personal_keywords_user_id_fk", "CASCADE");
  await addFk("role_summaries", "user_id", "role_summaries_user_id_fk", "CASCADE");
  await addFk("scoring_caps", "user_id", "scoring_caps_user_id_fk", "CASCADE");
  await addFk("targets", "added_by_user_id", "targets_added_by_user_id_fk", "SET NULL");

  // ── UNIQUE constraint on user_id for singleton-per-user tables ──────
  // Implemented as CREATE UNIQUE INDEX so IF NOT EXISTS is available.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "user_profile_user_id_unique" ON "user_profile" ("user_id")`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "personal_keywords_user_id_unique" ON "personal_keywords" ("user_id")`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "scoring_caps_user_id_unique" ON "scoring_caps" ("user_id")`;

  // ── Helpful per-user indexes ────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS "api_usage_user_called_at_idx" ON "api_usage" ("user_id", "called_at")`;
  await sql`CREATE INDEX IF NOT EXISTS "manual_checks_user_date_idx" ON "manual_checks" ("user_id", "check_date")`;

  // ── Backfill maintainer's join-table data ───────────────────────────
  await sql`
    INSERT INTO "user_targets" ("user_id", "target_slug")
    SELECT ${MAINTAINER_USER_ID}, "slug" FROM "targets"
    ON CONFLICT ("user_id", "target_slug") DO NOTHING
  `;
  await sql`
    INSERT INTO "user_manual_companies" ("user_id", "manual_company_name")
    SELECT ${MAINTAINER_USER_ID}, "name" FROM "manual_companies"
    ON CONFLICT ("user_id", "manual_company_name") DO NOTHING
  `;
  await sql`
    INSERT INTO "user_matches" (
      "user_id", "match_id", "level", "status",
      "applied_at", "dismissed_at", "dismiss_reason",
      "fit_score", "fit_summary", "fit_flag",
      "tier1_score", "tier1_confidence", "tier1_is_potential_bv", "tier1_quick_take",
      "pending_bv_verification", "bv_reasoning"
    )
    SELECT
      ${MAINTAINER_USER_ID}, "id", "level", "status",
      "applied_at", "dismissed_at", "dismiss_reason",
      "fit_score", "fit_summary", "fit_flag",
      "tier1_score", "tier1_confidence", "tier1_is_potential_bv", "tier1_quick_take",
      "pending_bv_verification", "bv_reasoning"
    FROM "matches"
    ON CONFLICT ("user_id", "match_id") DO NOTHING
  `;

  // ── Seed ats_catalog ────────────────────────────────────────────────
  // Source 1: current targets (all supported).
  const targetRows = (await sql`
    SELECT "slug", "display_name", "ats" FROM "targets"
  `) as Array<{ slug: string; display_name: string; ats: string }>;
  for (const t of targetRows) {
    await sql`
      INSERT INTO "ats_catalog" ("normalized_name", "canonical_name", "ats", "slug", "supported")
      VALUES (${t.slug}, ${t.display_name}, ${t.ats}, ${t.slug}, true)
      ON CONFLICT ("normalized_name") DO NOTHING
    `;
  }

  // Source 2: current manual_companies (none of which have a scannable ATS).
  const manualRows = (await sql`
    SELECT "name", "careers_url" FROM "manual_companies"
  `) as Array<{ name: string; careers_url: string }>;
  for (const m of manualRows) {
    await sql`
      INSERT INTO "ats_catalog" ("normalized_name", "canonical_name", "ats", "careers_url", "supported")
      VALUES (${normalize(m.name)}, ${m.name}, 'manual', ${m.careers_url}, false)
      ON CONFLICT ("normalized_name") DO NOTHING
    `;
  }

  // Source 3: hard-coded giants (insertion is no-op if a user's
  // manual_companies already covers them).
  for (const g of GIANTS) {
    await sql`
      INSERT INTO "ats_catalog" ("normalized_name", "canonical_name", "ats", "careers_url", "supported")
      VALUES (${normalize(g.canonical)}, ${g.canonical}, 'manual', ${g.url}, false)
      ON CONFLICT ("normalized_name") DO NOTHING
    `;
  }

  // ── Verification ────────────────────────────────────────────────────
  const counts = (await sql`
    SELECT
      (SELECT count(*) FROM user_targets WHERE user_id = ${MAINTAINER_USER_ID}) AS user_targets,
      (SELECT count(*) FROM user_manual_companies WHERE user_id = ${MAINTAINER_USER_ID}) AS user_manual_companies,
      (SELECT count(*) FROM user_matches WHERE user_id = ${MAINTAINER_USER_ID}) AS user_matches,
      (SELECT count(*) FROM ats_catalog) AS ats_catalog,
      (SELECT count(*) FROM api_usage WHERE user_id IS NULL) AS api_usage_null,
      (SELECT count(*) FROM manual_checks WHERE user_id IS NULL) AS manual_checks_null,
      (SELECT count(*) FROM user_profile WHERE user_id IS NULL) AS user_profile_null,
      (SELECT count(*) FROM personal_keywords WHERE user_id IS NULL) AS personal_keywords_null,
      (SELECT count(*) FROM role_summaries WHERE user_id IS NULL) AS role_summaries_null,
      (SELECT count(*) FROM scoring_caps WHERE user_id IS NULL) AS scoring_caps_null,
      (SELECT count(*) FROM targets) AS targets_total,
      (SELECT count(*) FROM matches) AS matches_total
  `) as Array<Record<string, string>>;

  console.log("\nMigration counts:");
  console.log(counts[0]);

  const c = counts[0] ?? {};
  const nullChecks = [
    "api_usage_null",
    "manual_checks_null",
    "user_profile_null",
    "personal_keywords_null",
    "role_summaries_null",
    "scoring_caps_null",
  ];
  for (const key of nullChecks) {
    if (Number(c[key]) > 0) {
      throw new Error(`Verification failed — ${key} = ${c[key]} (expected 0).`);
    }
  }
  if (Number(c.user_targets) !== Number(c.targets_total)) {
    throw new Error(
      `Verification failed — user_targets (${c.user_targets}) != targets (${c.targets_total}).`,
    );
  }
  if (Number(c.user_matches) !== Number(c.matches_total)) {
    throw new Error(
      `Verification failed — user_matches (${c.user_matches}) != matches (${c.matches_total}).`,
    );
  }

  console.log("\nMigration 0004 applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
