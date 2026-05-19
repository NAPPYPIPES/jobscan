// Backlog migration: re-score existing matches under the new two-tier
// funnel. For each eligible row, run Haiku triage and (if escalated)
// Sonnet deep-score. Persist Tier-1 fields + (optional) Tier-2 fields
// per the new pipeline rules.
//
// Why this script exists:
//   The new pipeline applies BV-vs-HIGH distinctions and a stricter
//   level_recommendation rule that the old single-tier Sonnet path
//   didn't enforce. Existing 418 scored rows have fit_score but no
//   tier1_score and no level_recommendation-derived level. Re-scoring
//   them surfaces the corrections (e.g. rows the old path called BV
//   that should be HIGH under the stricter rules).
//
// Usage:
//   npx tsx scripts/migrate-rescore.ts --dry-run                 # print plan, no API calls
//   npx tsx scripts/migrate-rescore.ts --dry-run --limit 5       # plan first 5
//   npx tsx scripts/migrate-rescore.ts --limit 5                 # actual run, 5 rows
//   npx tsx scripts/migrate-rescore.ts                           # full run
//   npx tsx scripts/migrate-rescore.ts --force                   # skip circuit breaker
//
// Cost circuit-breaker: aborts if cumulative spend exceeds $5 unless
// --force is passed. Catches a runaway escalation rate before it eats
// the month's budget.
//
// Idempotency: re-running picks up where the last run left off. Rows
// already touched (tier1_score IS NOT NULL) are skipped unless --force.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { and, desc, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { matches, userMatches } from "../db/schema";
import { ALL_ATSES, LEVEL_ORDER, type Level, type Sector } from "../lib/scan/types";
import { sectorForSlug } from "../db/targets";
import {
  extractScoringText,
  fetchDescription,
} from "../lib/fit/fetch-description";
import { triageRoleWithHaiku } from "../lib/fit/triage";
import {
  decideEscalation,
  levelFromTier1,
  type Tier1Result,
} from "../lib/fit/escalation";
import { scoreFitWithClaude, persistScore } from "../lib/fit/score";
import { getScoringCaps } from "../db/scoring-caps";
import { apiUsage } from "../db/schema";
import { MAINTAINER_USER_ID } from "../lib/auth/maintainer";
import { eq } from "drizzle-orm";

type Args = {
  dryRun: boolean;
  limit: number | null;
  force: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  let limit: number | null = null;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && limitIdx + 1 < args.length) {
    const n = parseInt(args[limitIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }
  return { dryRun, limit, force };
}

const COST_CIRCUIT_BREAKER_USD = 5.0;

async function main(): Promise<void> {
  const args = parseArgs();
  const db = getDb();

  // Phase 7: per-user state (level, status, fit_score, tier1_*) lives
  // on user_matches. The script is maintainer-only — join + scope to
  // MAINTAINER_USER_ID. Joined shape mirrors the legacy single-table
  // select so the rest of the script reads unchanged.
  const eligible = await db
    .select({
      id: matches.id,
      ats: matches.ats,
      companySlug: matches.companySlug,
      companyDisplayName: matches.companyDisplayName,
      jobId: matches.jobId,
      title: matches.title,
      location: matches.location,
      firstSeen: matches.firstSeen,
      level: userMatches.level,
      fitScore: userMatches.fitScore,
      tier1Score: userMatches.tier1Score,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, MAINTAINER_USER_ID),
        ne(userMatches.status, "dismissed"),
        isNull(matches.closedAt),
        inArray(matches.ats, ALL_ATSES),
      ),
    )
    .orderBy(desc(matches.firstSeen));

  // Three-way sort: unscored before scored; within each, by level.
  const sorted = eligible.sort((a, b) => {
    const aUnscored = a.fitScore == null ? 0 : 1;
    const bUnscored = b.fitScore == null ? 0 : 1;
    if (aUnscored !== bUnscored) return aUnscored - bUnscored;
    return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  });

  // Skip already-migrated rows (tier1_score IS NOT NULL) unless --force.
  const work = args.force
    ? sorted
    : sorted.filter((m) => m.tier1Score == null);

  const limited = args.limit ? work.slice(0, args.limit) : work;

  console.log(`Found ${eligible.length} eligible rows`);
  console.log(`  Unscored: ${eligible.filter((m) => m.fitScore == null).length}`);
  console.log(`  Already-migrated (tier1 set): ${eligible.filter((m) => m.tier1Score != null).length}`);
  console.log(`Processing: ${limited.length}${args.limit ? ` (--limit ${args.limit})` : ""}${args.dryRun ? " [DRY RUN]" : ""}\n`);

  if (args.dryRun) {
    for (const m of limited.slice(0, 20)) {
      console.log(
        `  ${m.companySlug.padEnd(20)} ${m.level.padEnd(7)} ${(m.fitScore ?? "—").toString().padStart(4)} ${m.title}`,
      );
    }
    if (limited.length > 20) {
      console.log(`  … and ${limited.length - 20} more`);
    }
    console.log(`\nNo API calls made. Re-run without --dry-run to execute.`);
    process.exit(0);
  }

  const caps = await getScoringCaps(MAINTAINER_USER_ID);
  let runSpend = 0;
  let triagedCount = 0;
  let escalatedCount = 0;
  let unchangedLevelCount = 0;
  let changedLevelCount = 0;
  let skippedNoDescCount = 0;
  let erroredCount = 0;

  const levelChanges: Array<{
    slug: string;
    title: string;
    from: Level;
    to: Level;
    score: number;
    reason: string;
  }> = [];

  for (let i = 0; i < limited.length; i++) {
    const m = limited[i]!;

    // Progress log every 25 rows. Always fires so --force runs still
    // surface live progress over a 10-15 min run. Cost circuit-breaker
    // is the conditional part — only active without --force, since
    // --force is the explicit "I know what I'm doing" override.
    if (i > 0 && i % 25 === 0) {
      console.log(`[migrate] progress: ${i}/${limited.length}, spent $${runSpend.toFixed(2)}`);
      if (!args.force && runSpend >= COST_CIRCUIT_BREAKER_USD) {
        console.warn(
          `[migrate] cost circuit-breaker tripped at $${runSpend.toFixed(2)} (limit: $${COST_CIRCUIT_BREAKER_USD.toFixed(2)}). Re-run with --force to continue.`,
        );
        break;
      }
    }

    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      skippedNoDescCount++;
      continue;
    }
    const desc = extractScoringText(rawDesc);

    // Tier-1. Maintainer-only script — pass MAINTAINER_USER_ID
    // explicitly so the triage call reads the maintainer's resume.
    const triageOut = await triageRoleWithHaiku({
      userId: MAINTAINER_USER_ID,
      title: m.title,
      company: m.companyDisplayName,
      companySlug: m.companySlug,
      location: m.location,
      descriptionSnippet: desc,
    });
    if (!triageOut.ok) {
      console.warn(`[migrate] triage failed for ${m.companySlug}/${m.jobId}: ${triageOut.reason}`);
      erroredCount++;
      continue;
    }
    runSpend += triageOut.costUsd;
    triagedCount++;

    // Log triage api_usage row. Maintainer-scoped — this script is a
    // one-off rescore tool run by the maintainer only.
    await db.insert(apiUsage).values({
      userId: MAINTAINER_USER_ID,
      matchId: m.id,
      tokensIn:
        triageOut.tokensIn + triageOut.cacheReadTokens + triageOut.cacheWriteTokens,
      tokensOut: triageOut.tokensOut,
      costUsd: triageOut.costUsd.toFixed(6),
      model: "claude-haiku-4-5-20251001",
      purpose: "triage",
    });

    // Decide escalation.
    const decision = decideEscalation(triageOut.tier1, caps, false);

    if (decision.escalate) {
      // Write Tier-1 fields up front.
      await writeTier1(m.id, triageOut.tier1);

      const sector: Sector = await sectorForSlug(m.companySlug);
      const sonnetOut = await scoreFitWithClaude({
        userId: MAINTAINER_USER_ID,
        matchId: m.id,
        title: m.title,
        company: m.companyDisplayName,
        companySlug: m.companySlug,
        location: m.location,
        description: desc,
        sector,
        tier1: triageOut.tier1,
        force: true, // bypass already-scored guard for re-scoring
      });
      if (!sonnetOut.ok) {
        console.warn(`[migrate] tier-2 failed for ${m.companySlug}/${m.jobId}: ${sonnetOut.reason}`);
        erroredCount++;
        continue;
      }
      runSpend += sonnetOut.costUsd;
      escalatedCount++;

      const oldLevel = m.level;
      await persistScore(
        MAINTAINER_USER_ID,
        m.id,
        sonnetOut.fit,
        sonnetOut.tokensIn,
        sonnetOut.tokensOut,
        sonnetOut.costUsd,
        undefined,
        {
          cacheReadTokens: sonnetOut.cacheReadTokens,
          cacheWriteTokens: sonnetOut.cacheWriteTokens,
        },
      );
      if (oldLevel !== sonnetOut.fit.levelRecommendation) {
        changedLevelCount++;
        levelChanges.push({
          slug: m.companySlug,
          title: m.title,
          from: oldLevel,
          to: sonnetOut.fit.levelRecommendation,
          score: sonnetOut.fit.score,
          reason: decision.reason,
        });
        console.log(
          `[migrate] CHANGED ${m.companySlug} ${oldLevel} → ${sonnetOut.fit.levelRecommendation} (${sonnetOut.fit.score.toFixed(1)}) — ${m.title}`,
        );
      } else {
        unchangedLevelCount++;
      }
    } else {
      // Not escalated. Persist Tier-1 only, cap level at MEDIUM.
      // Phase 5: write to user_matches for the maintainer.
      const newLevel = levelFromTier1(triageOut.tier1.tier1_score);
      const oldLevel = m.level;
      await db
        .update(userMatches)
        .set({
          tier1Score: triageOut.tier1.tier1_score.toFixed(1),
          tier1Confidence: triageOut.tier1.confidence,
          tier1IsPotentialBv: triageOut.tier1.is_potential_bv,
          tier1QuickTake: triageOut.tier1.quick_take,
          level: newLevel,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(userMatches.userId, MAINTAINER_USER_ID), eq(userMatches.matchId, m.id)),
        );
      if (oldLevel !== newLevel) {
        changedLevelCount++;
        levelChanges.push({
          slug: m.companySlug,
          title: m.title,
          from: oldLevel,
          to: newLevel,
          score: triageOut.tier1.tier1_score,
          reason: decision.reason,
        });
      } else {
        unchangedLevelCount++;
      }
    }
  }

  console.log(`\n=== Migration summary ===`);
  console.log(`Triaged:           ${triagedCount}`);
  console.log(`Escalated to T2:   ${escalatedCount} (${triagedCount > 0 ? ((escalatedCount / triagedCount) * 100).toFixed(0) : "0"}%)`);
  console.log(`Level unchanged:   ${unchangedLevelCount}`);
  console.log(`Level changed:     ${changedLevelCount}`);
  console.log(`Skipped (no JD):   ${skippedNoDescCount}`);
  console.log(`Errored:           ${erroredCount}`);
  console.log(`Total spend:       $${runSpend.toFixed(4)}`);
  if (levelChanges.length > 0) {
    console.log(`\n=== Level changes ===`);
    for (const c of levelChanges) {
      console.log(
        `  ${c.slug.padEnd(20)} ${c.from} → ${c.to.padEnd(7)} ${c.score.toFixed(1).padStart(4)}  ${c.title}`,
      );
    }
  }
  process.exit(0);
}

async function writeTier1(matchId: string, tier1: Tier1Result): Promise<void> {
  // Phase 5: per-user fields moved to user_matches. Maintainer-only
  // script, so we update the maintainer's row directly.
  const db = getDb();
  await db
    .update(userMatches)
    .set({
      tier1Score: tier1.tier1_score.toFixed(1),
      tier1Confidence: tier1.confidence,
      tier1IsPotentialBv: tier1.is_potential_bv,
      tier1QuickTake: tier1.quick_take,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(userMatches.userId, MAINTAINER_USER_ID), eq(userMatches.matchId, matchId)),
    );
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
