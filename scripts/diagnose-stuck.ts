// Why are the older never-scored MEDIUMs stuck? Four candidates:
//   (a) They're behind newer rows in the score-cron queue (DESC first_seen).
//   (b) Description fetch fails repeatedly (Workday especially).
//   (c) Haiku errors silently and they retry forever.
//   (d) Triage-cap hit before the queue reaches them.
//
// This script doesn't fix anything — just shows what state they're in.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = neon(url);

  const maintEmail = process.env.MAINTAINER_EMAIL;
  if (!maintEmail) throw new Error("MAINTAINER_EMAIL not set");
  const userRow = await sql`SELECT id FROM users WHERE email = ${maintEmail} LIMIT 1`;
  const userId = userRow[0].id as string;

  // Full list of stuck (>3d, never scored). Show ATS distribution.
  const byAts = await sql`
    SELECT m.ats, COUNT(*)::int AS n
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NULL
      AND um.tier1_score IS NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
      AND m.first_seen < now() - interval '3 days'
    GROUP BY m.ats
    ORDER BY n DESC`;
  console.log("=== Stuck never-scored MEDIUMs by ATS ===");
  for (const r of byAts) {
    console.log(`  ${String(r.ats).padEnd(12)} ${r.n}`);
  }

  // Are these old MEDIUMs scoring-eligible? Check level filter the cron
  // uses: level IN ('BV', 'HIGH', 'MEDIUM'). They should all qualify.
  // Show first 20 to eyeball.
  const sample = await sql`
    SELECT m.id, m.ats, m.company_slug, m.title, m.first_seen, m.last_seen,
           um.level, um.created_at, um.updated_at
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NULL
      AND um.tier1_score IS NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
      AND m.first_seen < now() - interval '3 days'
    ORDER BY m.first_seen ASC
    LIMIT 20`;
  console.log("\n=== 20 oldest stuck (ASC first_seen) ===");
  for (const r of sample) {
    console.log(`  [${r.ats}] ${r.company_slug} | first=${r.first_seen.toISOString().slice(0, 10)} last=${r.last_seen?.toISOString?.().slice(0, 10) ?? "?"} um_updated=${r.updated_at?.toISOString?.().slice(0, 10) ?? "?"}`);
    console.log(`     ${r.title}`);
  }

  // How many fresh-eligible rows are queued ahead of these (DESC first_seen
  // sort)? If hundreds, the cron rotation can't catch up.
  const queueAhead = await sql`
    SELECT COUNT(*)::int AS n
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.fit_score IS NULL
      AND um.tier1_score IS NULL
      AND um.level IN ('BV', 'HIGH', 'MEDIUM')
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL`;
  const ticksToClear = Math.ceil(queueAhead[0].n / 8);
  console.log(`\n=== Score queue depth ===`);
  console.log(`  total eligible unscored: ${queueAhead[0].n}`);
  console.log(`  at 8 rows/hour: ~${ticksToClear} hours to drain (${(ticksToClear/24).toFixed(1)} days)`);

  // Triage spend for this month — are we hitting the triage cap?
  const triageSpend = await sql`
    SELECT
      COUNT(*)::int AS calls,
      SUM(cost_usd::numeric)::numeric(8,4) AS spent
    FROM api_usage
    WHERE user_id = ${userId}
      AND purpose = 'triage'
      AND called_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`;
  console.log(`\n=== Month-to-date triage spend ===`);
  console.log(`  calls: ${triageSpend[0].calls}  spent: $${triageSpend[0].spent}`);

  // Scoring caps for this user.
  const caps = await sql`
    SELECT triage_cap_usd, score_cap_usd, monthly_cap_usd
    FROM user_extras WHERE user_id = ${userId} LIMIT 1`;
  if (caps[0]) {
    console.log(`  caps: triage=$${caps[0].triage_cap_usd}  score=$${caps[0].score_cap_usd}  total=$${caps[0].monthly_cap_usd}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
