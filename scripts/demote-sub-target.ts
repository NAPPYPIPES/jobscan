// One-shot: demote existing matches whose titles match the sub-target
// seniority patterns. The rule-classifier change in lib/scan/filter.ts
// stops these from being inserted by future scans, but rows that
// landed before the change still carry whatever level the AI gave
// them. This script forces them to LOW so they fall off the radar.
//
// Pure SQL — no AI cost. Doesn't touch the api_usage ledger.
//
// Usage:
//   npx tsx scripts/demote-sub-target.ts            # apply
//   npx tsx scripts/demote-sub-target.ts --dry-run  # preview only

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";

// Word-boundary match on the title patterns the new rule classifier
// also skips. Postgres ~* is case-insensitive regex.
const TITLE_PATTERN = `(^|[^a-z])(analyst|associate|coordinator|representative|junior|jr\\.?|intern|entry[- ]?level|new[- ]?grad|fellow|apprentice)([^a-z]|$)`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();

  // Preview which rows would change. Open + non-LOW only — already-LOW
  // rows are unaffected. Doesn't touch dismissed or closed rows.
  const preview = await db.execute(sql`
    select id, level, ats, company_slug, title
    from matches
    where status <> 'dismissed'
      and closed_at is null
      and level in ('BV','HIGH','MEDIUM')
      and title ~* ${TITLE_PATTERN}
    order by case level when 'BV' then 1 when 'HIGH' then 2 when 'MEDIUM' then 3 end, company_slug
  `);

  console.log(`${dryRun ? "[DRY RUN] " : ""}Found ${preview.rows.length} rows to demote to LOW:\n`);
  for (const r of preview.rows as Array<{ level: string; ats: string; company_slug: string; title: string }>) {
    console.log(
      `  ${r.level.padEnd(7)}  ${r.ats.padEnd(10)}  ${r.company_slug.padEnd(15)}  ${r.title}`,
    );
  }

  if (dryRun) {
    console.log(`\nNo writes. Re-run without --dry-run to apply.`);
    process.exit(0);
  }

  if (preview.rows.length === 0) {
    console.log("Nothing to demote.");
    process.exit(0);
  }

  const result = await db.execute(sql`
    update matches
    set level = 'LOW', updated_at = now()
    where status <> 'dismissed'
      and closed_at is null
      and level in ('BV','HIGH','MEDIUM')
      and title ~* ${TITLE_PATTERN}
  `);
  console.log(`\nDemoted ${preview.rows.length} rows to LOW.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
