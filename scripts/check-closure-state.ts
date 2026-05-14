// Diagnostic: post-scan inspection of closed_at + last_success_at
// state. One-off, run after a scan completes to confirm the new
// columns are populated as expected. Not part of the cron path.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = neon(url);

  const tot = await sql`SELECT count(*)::int AS n FROM matches`;
  const closed = await sql`SELECT count(*)::int AS n FROM matches WHERE closed_at IS NOT NULL`;
  const open = await sql`SELECT count(*)::int AS n FROM matches WHERE closed_at IS NULL AND status != 'dismissed'`;
  console.log("matches: total=%d, closed=%d, active(non-dismissed)=%d", tot[0].n, closed[0].n, open[0].n);

  const tgts = await sql`SELECT count(*)::int AS n FROM targets`;
  const tgtsScanned = await sql`SELECT count(*)::int AS n FROM targets WHERE last_success_at IS NOT NULL`;
  const tgtsFailing = await sql`
    SELECT slug, last_success_at FROM targets
    WHERE last_success_at IS NULL
       OR last_success_at < (SELECT max(last_success_at) FROM targets) - interval '90 minutes'
    ORDER BY last_success_at NULLS FIRST`;
  console.log("targets: total=%d, scanned-ever=%d, currently-failing=%d", tgts[0].n, tgtsScanned[0].n, tgtsFailing.length);
  for (const r of tgtsFailing) {
    console.log("  failing:", r.slug, r.last_success_at);
  }

  const recentClosed = await sql`
    SELECT company_slug, title, level, last_seen, closed_at
    FROM matches
    WHERE closed_at IS NOT NULL
    ORDER BY closed_at DESC LIMIT 5`;
  console.log("\nMost recent 5 closures:");
  for (const r of recentClosed) {
    console.log("  ", r.company_slug, "—", r.level, "—", r.title.slice(0, 60));
    console.log("    last_seen:", r.last_seen, "closed_at:", r.closed_at);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
