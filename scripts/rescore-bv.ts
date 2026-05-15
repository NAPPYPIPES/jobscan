// One-shot: re-score every current BV row under the updated Sonnet
// prompt's BV calibration. Without this, the 5 BV rows from the
// initial migration keep their original 7.9–9.2 fit scores — the new
// calibration says they should land 9.0–9.9. Uses the existing
// scoreFitWithClaude path with force=true to bypass the already-scored
// guard.
//
// Usage: npx tsx scripts/rescore-bv.ts
//
// Cost: ~5 × $0.018 = $0.09 (one Sonnet call per BV row).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { matches } from "../db/schema";
import {
  extractScoringText,
  fetchDescription,
} from "../lib/fit/fetch-description";
import { scoreFitWithClaude, persistScore } from "../lib/fit/score";
import { sectorForSlug } from "../db/targets";
import type { Sector } from "../lib/scan/types";
import type { Tier1Result } from "../lib/fit/escalation";

async function main(): Promise<void> {
  const db = getDb();

  const bvRows = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.level, "BV"),
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    );

  console.log(`Found ${bvRows.length} BV rows. Re-scoring with new calibration…\n`);

  let totalCost = 0;
  for (const m of bvRows) {
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      console.log(`  ${m.companySlug}: skipped (no JD)`);
      continue;
    }
    const desc = extractScoringText(rawDesc);
    const sector: Sector = await sectorForSlug(m.companySlug);

    // Reconstruct Tier-1 result from existing columns so Sonnet sees
    // the same context it did originally.
    const tier1: Tier1Result | undefined =
      m.tier1Score != null
        ? {
            tier1_score: parseFloat(m.tier1Score),
            confidence: (m.tier1Confidence as "low" | "medium" | "high") ?? "high",
            quick_take: m.tier1QuickTake ?? "",
            is_potential_bv: m.tier1IsPotentialBv ?? true,
          }
        : undefined;

    const oldScore = m.fitScore;
    const out = await scoreFitWithClaude({
      matchId: m.id,
      title: m.title,
      company: m.companyDisplayName,
      companySlug: m.companySlug,
      location: m.location,
      description: desc,
      sector,
      tier1,
      force: true,
    });

    if (!out.ok) {
      console.log(`  ${m.companySlug}: error (${out.reason})`);
      continue;
    }
    totalCost += out.costUsd;

    await persistScore(
      m.id,
      out.fit,
      out.tokensIn,
      out.tokensOut,
      out.costUsd,
      undefined,
      {
        cacheReadTokens: out.cacheReadTokens,
        cacheWriteTokens: out.cacheWriteTokens,
      },
    );

    const newLevel = out.fit.levelRecommendation;
    const arrow = oldScore != null && out.fit.score > parseFloat(oldScore) ? "↑" : "↓";
    console.log(
      `  ${m.companySlug.padEnd(20)}  ${oldScore ?? "—"} → ${out.fit.score.toFixed(1)} ${arrow}  level=${newLevel}  — ${m.title}`,
    );
    if (newLevel === "BV" && out.fit.bvReasoning) {
      console.log(`    → ${out.fit.bvReasoning}`);
    }
  }

  console.log(`\nTotal spend: $${totalCost.toFixed(4)}`);

  // Final state.
  const after = await db.execute(sql`
    select company_slug, title, fit_score, level, bv_reasoning
    from matches
    where level = 'BV' and status <> 'dismissed' and closed_at is null
    order by fit_score desc
  `);
  console.log(`\n=== Post-rescore BV roles (${after.rows.length}) ===`);
  for (const r of after.rows) {
    console.log(`  ${r.company_slug}  ${r.fit_score}  ${r.title}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[rescore-bv] failed:", err);
  process.exit(1);
});
