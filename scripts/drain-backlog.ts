// One-off backlog drain. Calls scoreUnscoredEligibleForUser in a loop
// until either: backlog is empty, score-cap is hit, or wall-clock budget
// elapses. Bypasses the 60s Vercel function ceiling by running locally.
// Re-run if interrupted — it's idempotent (already-scored rows skip).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { scoreUnscoredEligibleForUser } from "@/lib/fit/score";

const BATCH = 8;                       // matches cron's per-tick limit
const PER_BATCH_BUDGET_MS = 90_000;    // generous; local has no 60s ceiling
const TOTAL_BUDGET_MS = 30 * 60_000;   // bail after 30 min hard stop

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = neon(url);
  const maintEmail = process.env.MAINTAINER_EMAIL;
  if (!maintEmail) throw new Error("MAINTAINER_EMAIL not set");
  const userRow = await sql`SELECT id FROM users WHERE email = ${maintEmail} LIMIT 1`;
  const userId = userRow[0].id as string;
  console.log(`Draining for ${maintEmail} (${userId.slice(0, 8)})...\n`);

  const start = Date.now();
  const totals = { scored: 0, triagedOnly: 0, pendingBvProcessed: 0, skipped: 0, errored: 0 };
  let batch = 0;

  while (Date.now() - start < TOTAL_BUDGET_MS) {
    batch++;
    const result = await scoreUnscoredEligibleForUser(userId, {
      limit: BATCH,
      timeBudgetMs: PER_BATCH_BUDGET_MS,
    });
    totals.scored += result.scored;
    totals.triagedOnly += result.triagedOnly;
    totals.pendingBvProcessed += result.pendingBvProcessed;
    totals.skipped += result.skipped;
    totals.errored += result.errored;
    console.log(
      `[batch ${batch}] scored=${result.scored} triaged=${result.triagedOnly} ` +
      `pending_bv=${result.pendingBvProcessed} skip=${result.skipped} err=${result.errored} ` +
      `remaining=${result.remaining}`,
    );
    if (result.scored + result.triagedOnly + result.pendingBvProcessed === 0) {
      // Nothing processed this batch — either backlog empty, all skipped
      // (no descriptions), or capped. Bail to avoid spin loop.
      console.log("\nNo more progress — stopping.");
      break;
    }
    if (result.remaining === 0) {
      console.log("\nBacklog empty.");
      break;
    }
  }

  console.log("\n=== Totals ===");
  console.log(totals);
  console.log(`elapsed: ${((Date.now() - start) / 1000).toFixed(0)}s, batches: ${batch}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
