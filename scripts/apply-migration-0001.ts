// One-shot migration runner for drizzle/0001_add_closed_at_and_last_success.sql.
// Adds two nullable timestamp columns (matches.closed_at,
// targets.last_success_at) idempotently. Safe to re-run.
//
// Usage: npx tsx scripts/apply-migration-0001.ts
//
// Why this isn't `drizzle-kit migrate`: the project uses neon-http
// (not neon-serverless), and drizzle-kit migrate prefers connection-
// based drivers. Manual application via the same neon-http client the
// app uses keeps the auth path identical to runtime.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set in .env.local");

  const sql = neon(url);
  console.log("Adding matches.closed_at + targets.last_success_at (idempotent)…");
  await sql`ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone`;
  await sql`ALTER TABLE "targets" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone`;

  const matchesCol = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'matches' AND column_name = 'closed_at'
  `;
  const targetsCol = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'targets' AND column_name = 'last_success_at'
  `;
  console.log("matches.closed_at:", matchesCol[0]);
  console.log("targets.last_success_at:", targetsCol[0]);
  if (matchesCol.length !== 1 || targetsCol.length !== 1) {
    throw new Error("Verification failed — at least one column missing.");
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
