// Rescore active Sonnet-scored MEDIUM rows under the updated prompt
// that softens ic_role / partnerships_specialist caps and tightens the
// HIGH bucket. Force-bypasses the fit_score-NOT-NULL idempotency check.
//
// Cost: ~142 rows × ~$0.02 ≈ $3 in Sonnet.
//
// Usage: npx tsx scripts/rescore-mediums.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { getDb } from "../db/client";
import { matches, userMatches } from "../db/schema";
import {
  extractScoringText,
  fetchDescription,
} from "../lib/fit/fetch-description";
import { scoreFitWithClaude, persistScore } from "../lib/fit/score";
import { sectorForSlug } from "../db/targets";
import type { Sector } from "../lib/scan/types";
import type { Tier1Result } from "../lib/fit/escalation";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const maintEmail = process.env.MAINTAINER_EMAIL;
  if (!maintEmail) throw new Error("MAINTAINER_EMAIL not set");
  const sql = neon(url);
  const userRow = await sql`SELECT id FROM users WHERE email = ${maintEmail} LIMIT 1`;
  const userId = userRow[0].id as string;
  console.log(`Rescoring MEDIUMs for ${maintEmail} (${userId.slice(0, 8)})…\n`);

  const db = getDb();

  // Active Sonnet-scored MEDIUMs joined with their match facts +
  // existing tier1 result (so Sonnet sees Haiku's prior take).
  const rows = await db
    .select({
      id: matches.id,
      ats: matches.ats,
      companySlug: matches.companySlug,
      companyDisplayName: matches.companyDisplayName,
      jobId: matches.jobId,
      title: matches.title,
      location: matches.location,
      // Pre-state for the before/after table.
      oldFitScore: userMatches.fitScore,
      oldLevel: userMatches.level,
      oldFlag: userMatches.fitFlag,
      tier1Score: userMatches.tier1Score,
      tier1Confidence: userMatches.tier1Confidence,
      tier1QuickTake: userMatches.tier1QuickTake,
      tier1IsPotentialBv: userMatches.tier1IsPotentialBv,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        eq(userMatches.level, "MEDIUM"),
        isNotNull(userMatches.fitScore),
        ne(userMatches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    );

  console.log(`Found ${rows.length} active Sonnet-scored MEDIUMs to rescore.\n`);

  let totalCost = 0;
  let promotions = 0;
  let demotions = 0;
  let unchanged = 0;
  let skipped = 0;
  let errored = 0;
  const results: Array<{
    slug: string;
    title: string;
    oldScore: string | null;
    newScore: string | null;
    oldLevel: string;
    newLevel: string;
    oldFlag: string | null;
    newFlag: string | null;
  }> = [];

  for (const m of rows) {
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      skipped++;
      process.stdout.write("s");
      continue;
    }
    const desc = extractScoringText(rawDesc);
    const sector: Sector = await sectorForSlug(m.companySlug);

    const tier1: Tier1Result | undefined =
      m.tier1Score != null
        ? {
            tier1_score: parseFloat(m.tier1Score),
            confidence:
              (m.tier1Confidence as "low" | "medium" | "high") ?? "medium",
            quick_take: m.tier1QuickTake ?? "",
            is_potential_bv: m.tier1IsPotentialBv ?? false,
          }
        : undefined;

    const out = await scoreFitWithClaude({
      userId,
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
      errored++;
      process.stdout.write("e");
      continue;
    }
    totalCost += out.costUsd;

    await persistScore(
      userId,
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

    const newScore = out.fit.score.toFixed(1);
    const newLevel = out.fit.levelRecommendation;
    if (newLevel === m.oldLevel) {
      unchanged++;
      process.stdout.write(".");
    } else if (
      (m.oldLevel === "MEDIUM" && (newLevel === "HIGH" || newLevel === "BV")) ||
      (m.oldLevel === "LOW" && newLevel !== "LOW")
    ) {
      promotions++;
      process.stdout.write("↑");
    } else {
      demotions++;
      process.stdout.write("↓");
    }

    results.push({
      slug: m.companySlug,
      title: m.title,
      oldScore: m.oldFitScore,
      newScore,
      oldLevel: m.oldLevel,
      newLevel,
      oldFlag: m.oldFlag,
      newFlag: out.fit.flag,
    });
  }
  process.stdout.write("\n\n");

  // Sort: promotions first (by new score desc), then demotions, then unchanged.
  results.sort((a, b) => {
    const ap = a.oldLevel !== a.newLevel ? 0 : 1;
    const bp = b.oldLevel !== b.newLevel ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return parseFloat(b.newScore ?? "0") - parseFloat(a.newScore ?? "0");
  });

  console.log("=== Level changes ===");
  for (const r of results) {
    if (r.oldLevel === r.newLevel) continue;
    console.log(
      `  ${r.oldLevel.padEnd(6)} → ${r.newLevel.padEnd(6)}  ${(r.oldScore ?? "—").padStart(4)} → ${(r.newScore ?? "—").padStart(4)}  ${r.slug.padEnd(15)}  ${r.title}`,
    );
    if (r.newFlag !== r.oldFlag) {
      console.log(`    flag: ${r.oldFlag ?? "none"} → ${r.newFlag ?? "none"}`);
    }
  }

  console.log(
    `\n${promotions} ↑   ${demotions} ↓   ${unchanged} =   skipped=${skipped}  errored=${errored}   ($${totalCost.toFixed(4)} spent)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
