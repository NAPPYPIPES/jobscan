// One-off: rows scored before the flag/level consistency override
// existed have flag = level_mismatch but level = MEDIUM. New scores
// would land at LOW because of the override in lib/fit/score.ts:652-662.
// Bring legacy rows in line.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = neon(url);

  // Find them first — log what's about to change.
  const before = await sql`
    SELECT um.match_id, m.title, m.company_display_name,
           um.fit_score, um.fit_flag, um.level
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.fit_flag = 'level_mismatch'
      AND um.level != 'LOW'`;
  console.log(`Found ${before.length} rows with flag=level_mismatch but level != LOW:`);
  for (const r of before) {
    console.log(`  [${r.level} → LOW] ${r.company_display_name} — ${r.title} (score=${r.fit_score})`);
  }
  if (before.length === 0) {
    console.log("Nothing to fix.");
    return;
  }

  const result = await sql`
    UPDATE user_matches
    SET level = 'LOW', updated_at = now()
    WHERE fit_flag = 'level_mismatch'
      AND level != 'LOW'`;
  console.log(`\nUpdated ${(result as { rowCount?: number }).rowCount ?? "?"} rows to level=LOW.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
