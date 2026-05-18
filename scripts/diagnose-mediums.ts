// One-off: who decided these were MEDIUM — Sonnet or Haiku alone?
// Splits MEDIUM rows by whether fit_score is populated (Sonnet scored
// them) vs NULL (Haiku triaged, didn't escalate). Plus a sample of
// each so we can eyeball relevance.

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
  if (!userRow[0]) throw new Error(`No user found for ${maintEmail}`);
  const userId = userRow[0].id as string;
  console.log(`user: ${maintEmail} (${userId.slice(0, 8)})\n`);

  // Counts: MEDIUMs split by who scored them.
  const counts = await sql`
    SELECT
      COUNT(*) FILTER (WHERE um.fit_score IS NOT NULL)::int AS sonnet_scored,
      COUNT(*) FILTER (WHERE um.fit_score IS NULL AND um.tier1_score IS NOT NULL)::int AS haiku_only,
      COUNT(*) FILTER (WHERE um.fit_score IS NULL AND um.tier1_score IS NULL)::int AS unscored,
      COUNT(*)::int AS total
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL`;
  const c = counts[0];
  console.log("=== MEDIUM rows breakdown ===");
  console.log(`total active MEDIUMs:       ${c.total}`);
  console.log(`  Sonnet-scored (fit_score set):  ${c.sonnet_scored}`);
  console.log(`  Haiku-only (fit_score NULL, tier1 set): ${c.haiku_only}`);
  console.log(`  Never scored (classifier only): ${c.unscored}\n`);

  // Sample 10 Haiku-only MEDIUMs sorted by tier1_score desc — these
  // are the ones Haiku liked just enough to keep at MEDIUM without
  // bothering Sonnet.
  const haikuOnly = await sql`
    SELECT m.title, m.company_display_name, m.location,
           um.tier1_score, um.tier1_confidence, um.tier1_is_potential_bv,
           um.tier1_quick_take
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NULL
      AND um.tier1_score IS NOT NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    ORDER BY um.tier1_score DESC
    LIMIT 15`;
  console.log("=== Top 15 Haiku-only MEDIUMs (sorted by tier1_score) ===");
  for (const r of haikuOnly) {
    console.log(`  [${r.tier1_score}/${r.tier1_confidence}${r.tier1_is_potential_bv ? "/BV?" : ""}] ${r.company_display_name} — ${r.title}`);
    console.log(`    loc: ${r.location || "(none)"}`);
    console.log(`    haiku: ${r.tier1_quick_take}`);
  }
  console.log();

  // Sonnet-scored MEDIUMs: Sonnet explicitly chose MEDIUM.
  const sonnetScored = await sql`
    SELECT m.title, m.company_display_name, m.location,
           um.fit_score, um.fit_flag, um.fit_summary
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NOT NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    ORDER BY um.fit_score DESC
    LIMIT 10`;
  console.log("=== Top 10 Sonnet-scored MEDIUMs ===");
  for (const r of sonnetScored) {
    console.log(`  [${r.fit_score}/${r.fit_flag}] ${r.company_display_name} — ${r.title}`);
    console.log(`    sonnet: ${r.fit_summary}`);
  }

  // Sonnet-MEDIUMs split by flag — shows how many were forced down by
  // ic_role / partnerships cap vs. organic adjacent-fit calls.
  const flagBreak = await sql`
    SELECT COALESCE(um.fit_flag, 'none') AS flag,
           COUNT(*)::int AS n,
           AVG(um.fit_score::numeric)::numeric(3,1) AS avg_score,
           MAX(um.fit_score::numeric) AS max_score
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NOT NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    GROUP BY flag
    ORDER BY n DESC`;
  console.log("\n=== Sonnet-MEDIUMs by flag ===");
  for (const r of flagBreak) {
    console.log(`  ${String(r.flag).padEnd(28)} n=${String(r.n).padStart(3)}  avg=${r.avg_score}  max=${r.max_score}`);
  }

  // High-scoring Sonnet-MEDIUMs (≥8.0) with no flag — these arguably
  // should be HIGH per Sonnet's own prompt rules. The fact they're
  // MEDIUM suggests Sonnet is being over-cautious with level_recommendation.
  const overcautious = await sql`
    SELECT m.title, m.company_display_name,
           um.fit_score, um.fit_flag, um.fit_summary
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score::numeric >= 8.0
      AND (um.fit_flag IS NULL OR um.fit_flag IN ('none', 'partnerships_specialist'))
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    ORDER BY um.fit_score DESC
    LIMIT 20`;
  console.log("\n=== Sonnet-MEDIUMs ≥8.0 with no hard flag (likely should be HIGH) ===");
  for (const r of overcautious) {
    console.log(`  [${r.fit_score}/${r.fit_flag || "none"}] ${r.company_display_name} — ${r.title}`);
    console.log(`    sonnet: ${r.fit_summary}`);
  }

  // Sample of the 104 never-scored MEDIUMs — why didn't they get triaged?
  // Check first_seen to see if they're recent (cron will pick up) vs old.
  const unscored = await sql`
    SELECT m.title, m.company_display_name, m.location, m.first_seen, m.ats
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NULL
      AND um.tier1_score IS NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    ORDER BY m.first_seen DESC
    LIMIT 15`;
  console.log("\n=== 15 most-recent never-scored MEDIUMs ===");
  for (const r of unscored) {
    console.log(`  [${r.ats}] ${r.company_display_name} — ${r.title}`);
    console.log(`    first_seen: ${r.first_seen}  loc: ${r.location || "(none)"}`);
  }

  // Age distribution for never-scored — distinguish "cron will catch
  // up" from "permanently stuck".
  const unscoredAge = await sql`
    SELECT
      CASE
        WHEN m.first_seen > now() - interval '1 day' THEN '<1d'
        WHEN m.first_seen > now() - interval '3 days' THEN '1-3d'
        WHEN m.first_seen > now() - interval '7 days' THEN '3-7d'
        WHEN m.first_seen > now() - interval '14 days' THEN '7-14d'
        ELSE '>14d'
      END AS age_band,
      COUNT(*)::int AS n
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.level = 'MEDIUM'
      AND um.fit_score IS NULL
      AND um.tier1_score IS NULL
      AND um.status != 'dismissed'
      AND m.closed_at IS NULL
    GROUP BY age_band
    ORDER BY MIN(m.first_seen) DESC`;
  console.log("\n=== Never-scored MEDIUMs by age ===");
  for (const r of unscoredAge) {
    console.log(`  ${String(r.age_band).padEnd(6)} ${r.n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
