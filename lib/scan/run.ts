import { getPersonalKeywords, type LoadedPersonalKeywords } from "@/db/personal-keywords";
import { getTargets, validateTargets } from "@/db/targets";
import type { Target as TargetRow } from "@/db/schema";
import { loadPriorIdsBySlug, persistScanResults } from "@/db/matches";
import { scanAshbyCompany } from "./adapters/ashby";
import { scanGreenhouseCompany } from "./adapters/greenhouse";
import { scanLeverCompany } from "./adapters/lever";
import { scanWorkdayCompany } from "./adapters/workday";
import { LEVEL_LABEL, type CompanyResult, type Level, type Target } from "./types";

export type RunSummary = {
  timestamp: string;
  isBaseline: boolean;
  scannedCount: number;
  targetCount: number;
  totalJobs: number;
  totalRoles: number;
  totalNew: number;
  totals: Record<Level, number>;
  results: CompanyResult[];
};

// Build an empty RunSummary for the no-targets short-circuit. Keeps
// the return shape consistent so callers (cron route + CLI) can render
// the same way for "scan ran fine, found nothing" vs "scan didn't run
// because there's nothing to scan."
function emptySummary(timestamp: string): RunSummary {
  return {
    timestamp,
    isBaseline: true,
    scannedCount: 0,
    targetCount: 0,
    totalJobs: 0,
    totalRoles: 0,
    totalNew: 0,
    totals: { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    results: [],
  };
}

// Single-company scan with per-ATS dispatch. Returns null on fetch
// failure so the parallel loop in runScanAndPersist can keep going.
async function scanOne(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult | null> {
  try {
    switch (target.ats) {
      case "greenhouse":
        return await scanGreenhouseCompany(target, priorIds, isBaseline, vocab);
      case "ashby":
        return await scanAshbyCompany(target, priorIds, isBaseline, vocab);
      case "lever":
        return await scanLeverCompany(target, priorIds, isBaseline, vocab);
      case "workday":
        return await scanWorkdayCompany(target, priorIds, isBaseline, vocab);
    }
  } catch (err) {
    console.error(`[${target.slug}] fetch failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// Convert a DB target row into the in-memory Target shape the
// adapters / classifier expect. DB row has nullable sector/stage; the
// Target type uses optional fields. Same data, just different
// optional-vs-null spellings.
function dbRowToTarget(r: TargetRow): Target {
  return {
    ats: r.ats,
    slug: r.slug,
    displayName: r.displayName,
    sector: r.sector ?? undefined,
    stage: r.stage ?? undefined,
  };
}

// Orchestrate a full scan: load prior IDs from DB, fetch every target
// in parallel, persist results, return a summary. Used by both the CLI
// (scan.ts) and the API route. Callers decide how to format/report.
export async function runScanAndPersist(): Promise<RunSummary> {
  const timestamp = new Date().toISOString();

  // Pre-fetch the personal vocab and the target list once per run.
  // Both modules cache in memory after the first call, so subsequent
  // refs inside this run are sub-ms.
  const [targetRows, vocab] = await Promise.all([
    getTargets(),
    getPersonalKeywords(),
  ]);

  // Empty-targets guardrail (per plan). A fresh forker who ran
  // drizzle-kit push but skipped `npm run ingest-config` would
  // otherwise have the scanner silently do nothing every hour.
  if (targetRows.length === 0) {
    console.warn(
      "[scan] targets table is empty — run `npm run ingest-config` to seed it. Skipping this run.",
    );
    return emptySummary(timestamp);
  }

  validateTargets(targetRows);
  const TARGETS: Target[] = targetRows.map(dbRowToTarget);

  const priorBySlug = await loadPriorIdsBySlug();
  // Baseline if no prior data in DB. Triggers the first-scan-of-a-new-
  // company logic (is_baseline=true on insert) which keeps the digest
  // quiet on initial deploy.
  const priorIdCount = [...priorBySlug.values()].reduce((sum, s) => sum + s.size, 0);
  const isBaseline = priorIdCount === 0;

  if (isBaseline) {
    console.log("No usable prior scan data in DB — baseline run. All matches flagged new=false.");
  }

  // Run every per-company scan in parallel. With many targets,
  // sequential fetches would push past Vercel's 60s function timeout
  // (~2s/company). Concurrent fetches against three different ATSs
  // are well within their public-API tolerances. Per-company errors
  // are caught in scanOne so one bad slug doesn't sink the whole run.
  const settled = await Promise.all(
    TARGETS.map((t) => scanOne(t, priorBySlug.get(t.slug), isBaseline, vocab)),
  );
  const results = settled.filter((r): r is CompanyResult => r !== null);

  const totals: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let totalRoles = 0;
  let totalJobs = 0;
  let totalNew = 0;
  for (const result of results) {
    console.log(`\n=== ${result.displayName} (${result.slug}) ===`);
    for (const m of result.matches) {
      const marker = m.isNew ? "★ " : "  ";
      console.log(`${marker}[${LEVEL_LABEL[m.level]}] ${m.title} — ${m.location}`);
    }
    const b = result.levelBreakdown;
    console.log(
      `Found ${result.matches.length} roles (${b.BV} BV, ${b.HIGH} HIGH, ${b.MEDIUM} MED, ${b.LOW} LOW, ${result.newCount} new) ` +
        `out of ${result.total} total at ${result.displayName}.`,
    );
    totalRoles += result.matches.length;
    totalJobs += result.total;
    totalNew += result.newCount;
    for (const level of Object.keys(totals) as Level[]) {
      totals[level] += result.levelBreakdown[level];
    }
  }

  const baselineSlugs = new Set(
    TARGETS.map((t) => t.slug).filter((s) => !priorBySlug.has(s)),
  );
  await persistScanResults(results, baselineSlugs);

  return {
    timestamp,
    isBaseline,
    scannedCount: results.length,
    targetCount: TARGETS.length,
    totalJobs,
    totalRoles,
    totalNew,
    totals,
    results,
  };
}
