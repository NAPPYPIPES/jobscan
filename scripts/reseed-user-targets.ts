// Reseed the maintainer's per-user join tables from the global tables.
//
// Why this exists: `ingest-config -- targets` and
// `ingest-config -- manual-companies` do a DELETE+INSERT on the global
// `targets` / `manual_companies` tables. Both have child rows in
// `user_targets` / `user_manual_companies` with ON DELETE CASCADE, so
// every re-ingest silently wipes the maintainer's per-user watchlist —
// which empties the dashboard until the next scan's fan-out runs.
//
// Run this after any target / manual-company re-ingest to restore the
// maintainer's watchlist immediately, then run `npm run scan` to fan
// out matches into user_matches.
//
// Idempotent: ON CONFLICT DO NOTHING. Safe to re-run.
//
// Usage:
//   npm run reseed-user-targets

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { MAINTAINER_USER_ID } from "../lib/auth/maintainer";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);

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

  const targets = (await sql`
    SELECT count(*)::int AS n FROM "user_targets" WHERE "user_id" = ${MAINTAINER_USER_ID}
  `) as Array<{ n: number }>;
  const manual = (await sql`
    SELECT count(*)::int AS n FROM "user_manual_companies" WHERE "user_id" = ${MAINTAINER_USER_ID}
  `) as Array<{ n: number }>;

  console.log(`Reseeded maintainer watchlist:`);
  console.log(`  user_targets:           ${targets[0]?.n ?? 0}`);
  console.log(`  user_manual_companies:  ${manual[0]?.n ?? 0}`);
  console.log(`\nNext: run \`npm run scan\` to fan out matches into user_matches.`);
}

main().catch((err) => {
  console.error("reseed-user-targets failed:", err);
  process.exit(1);
});
