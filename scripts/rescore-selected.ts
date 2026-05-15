// Re-score the high-value rows under the current rubric + resume,
// printing a before/after table. "High-value" = every BV row + the
// top N HIGH rows by current fit_score. Used to demo the impact of
// rubric / resume changes without re-running the full backlog.
//
// Cost: ~15 rows × ($0.002 Haiku + $0.018 Sonnet) ≈ $0.30.
//
// Usage:
//   npx tsx scripts/rescore-selected.ts            # BV + top 10 HIGH
//   npx tsx scripts/rescore-selected.ts 20         # BV + top 20 HIGH

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
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

type RowSnapshot = {
  id: string;
  slug: string;
  title: string;
  oldFitScore: string | null;
  oldLevel: string;
  oldFlag: string | null;
};

async function main(): Promise<void> {
  const topHigh = parseInt(process.argv[2] ?? "10", 10);
  const db = getDb();

  const open = and(
    ne(matches.status, "dismissed"),
    isNull(matches.closedAt),
  );

  const bv = await db
    .select()
    .from(matches)
    .where(and(open, eq(matches.level, "BV")));

  const high = await db
    .select()
    .from(matches)
    .where(and(open, eq(matches.level, "HIGH"), isNotNull(matches.fitScore)))
    .orderBy(desc(matches.fitScore))
    .limit(topHigh);

  // Snapshot pre-rescore.
  const snapshots: Map<string, RowSnapshot> = new Map();
  for (const m of [...bv, ...high]) {
    snapshots.set(m.id, {
      id: m.id,
      slug: m.companySlug,
      title: m.title,
      oldFitScore: m.fitScore,
      oldLevel: m.level,
      oldFlag: m.fitFlag,
    });
  }

  console.log(
    `Rescoring ${bv.length} BV + ${high.length} HIGH rows under updated rubric + resume…\n`,
  );

  let totalCost = 0;
  for (const m of [...bv, ...high]) {
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      console.log(`  ${m.companySlug}/${m.jobId}: skip (no JD)`);
      continue;
    }
    const desc = extractScoringText(rawDesc);
    const sector: Sector = await sectorForSlug(m.companySlug);

    const tier1: Tier1Result | undefined =
      m.tier1Score != null
        ? {
            tier1_score: parseFloat(m.tier1Score),
            confidence:
              (m.tier1Confidence as "low" | "medium" | "high") ?? "high",
            quick_take: m.tier1QuickTake ?? "",
            is_potential_bv: m.tier1IsPotentialBv ?? false,
          }
        : undefined;

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
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  // Re-fetch and print before/after.
  const ids = Array.from(snapshots.keys());
  const after = await db
    .select()
    .from(matches);
  const afterMap = new Map(after.filter((m) => ids.includes(m.id)).map((m) => [m.id, m]));

  console.log(`\n=== BEFORE / AFTER ===`);
  console.log(`Spend on this rescore: $${totalCost.toFixed(4)}\n`);
  // Header
  console.log(
    "  " +
      "Company".padEnd(15) +
      " " +
      "Old".padStart(5) +
      " → " +
      "New".padStart(5) +
      "  " +
      "OldLvl→NewLvl".padEnd(15) +
      "  Title",
  );
  console.log("  " + "-".repeat(70));

  // Sort by new fit_score desc.
  const rows = Array.from(snapshots.values())
    .map((s) => {
      const a = afterMap.get(s.id)!;
      return {
        snap: s,
        newFitScore: a.fitScore,
        newLevel: a.level,
        newFlag: a.fitFlag,
      };
    })
    .sort((x, y) => parseFloat(y.newFitScore ?? "0") - parseFloat(x.newFitScore ?? "0"));

  let promotions = 0;
  let demotions = 0;
  let unchanged = 0;
  for (const r of rows) {
    const old = r.snap.oldFitScore ?? "—";
    const next = r.newFitScore ?? "—";
    const arrow =
      r.snap.oldFitScore && r.newFitScore
        ? parseFloat(next) > parseFloat(old)
          ? "↑"
          : parseFloat(next) < parseFloat(old)
            ? "↓"
            : "="
        : " ";
    if (arrow === "↑") promotions++;
    else if (arrow === "↓") demotions++;
    else unchanged++;
    const levelChange =
      r.snap.oldLevel === r.newLevel
        ? r.snap.oldLevel.padEnd(15)
        : `${r.snap.oldLevel} → ${r.newLevel}`.padEnd(15);
    console.log(
      "  " +
        r.snap.slug.padEnd(15) +
        " " +
        old.toString().padStart(5) +
        " " +
        arrow +
        " " +
        next.toString().padStart(5) +
        "  " +
        levelChange +
        "  " +
        r.snap.title,
    );
    if (r.newFlag && r.newFlag !== "none" && r.newFlag !== r.snap.oldFlag) {
      console.log(`     ↳ flag: ${r.snap.oldFlag ?? "none"} → ${r.newFlag}`);
    }
  }
  console.log(
    `\n${promotions} ↑   ${demotions} ↓   ${unchanged} =   ($${totalCost.toFixed(4)} spent)`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
