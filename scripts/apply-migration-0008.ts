// One-shot migration runner for Phase 7 cleanup: drop the per-user
// state columns from `matches`. Phases 4-6 moved every read off these
// columns onto `user_matches`; this drop is the final irreversible
// step. Memory note: phase-7-cleanup.md.
//
// Idempotent via DROP COLUMN IF EXISTS — re-runs are no-ops once the
// drops have landed. Per-statement (one ALTER per call) because the
// neon-http driver doesn't support multi-statement transactions; this
// matches the existing apply-migration-0003..0007.ts runners and is
// the reason the drizzle journal isn't used for these.
//
// Usage:
//   npx tsx scripts/apply-migration-0008.ts
//
// Safety: run AFTER confirming for ~1-2 weeks of clean operation that
// nothing in app code or scripts still reads these columns (the read
// paths were migrated to user_matches in phases 4-6, and Phase 7
// cleanup verified zero remaining hits via `grep` and `tsc`).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

const DEAD_COLUMNS = [
  "level",
  "status",
  "applied_at",
  "dismissed_at",
  "dismiss_reason",
  "fit_score",
  "fit_summary",
  "fit_flag",
  "tier1_score",
  "tier1_confidence",
  "tier1_is_potential_bv",
  "tier1_quick_take",
  "pending_bv_verification",
  "bv_reasoning",
] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");
  const sql = neon(url);

  console.log(
    `Applying migration 0008: drop ${DEAD_COLUMNS.length} per-user columns from matches (idempotent)…`,
  );

  // Column names are validated against the hardcoded DEAD_COLUMNS list
  // — not interpolated from user input — so the unparameterized SQL is
  // safe. neon's tagged-template can't parameterize identifiers anyway.
  for (const col of DEAD_COLUMNS) {
    await sql.query(`ALTER TABLE "matches" DROP COLUMN IF EXISTS "${col}"`);
    console.log(`  dropped matches.${col}`);
  }

  // Verification: column should be gone.
  const remaining = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'matches'
      AND column_name = ANY(${DEAD_COLUMNS as unknown as string[]})
  `;
  if (remaining.length > 0) {
    console.error(
      `[migration 0008] WARNING: ${remaining.length} columns still present:`,
      remaining.map((r) => r.column_name),
    );
    process.exit(1);
  }

  console.log(`\nMigration 0008 applied successfully. matches is now global-only.`);
}

main().catch((err) => {
  console.error("[migration 0008] failed:", err);
  process.exit(1);
});
