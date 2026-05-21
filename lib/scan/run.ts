import { getPersonalKeywords, type LoadedPersonalKeywords } from "@/db/personal-keywords";
import { getTargets, validateTargets } from "@/db/targets";
import type { Target as TargetRow } from "@/db/schema";
import { loadPriorIdsBySlug, persistScanResults } from "@/db/matches";
import { fanOutToUserMatches } from "./fanout";
import { scanAshbyCompany } from "./adapters/ashby";
import { scanGreenhouseCompany } from "./adapters/greenhouse";
import { scanLeverCompany } from "./adapters/lever";
import { scanWorkableCompany } from "./adapters/workable";
import { scanWorkdayCompany } from "./adapters/workday";
import { LEVEL_LABEL, type CompanyResult, type Level, type Target } from "./types";
import { getScoringCaps } from "@/db/scoring-caps";
import { MAINTAINER_USER_ID } from "@/lib/auth/maintainer";
import { countNewJobsToday, countNewJobsTodayForCompany } from "./dayCaps";

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

// Apply per-day caps to a results array IN PLACE. Mutates result.matches
// for each company to drop net-new arrivals beyond available headroom.
// Logs one line per affected company so the scan output makes truncation
// visible. No DB writes here — pure filter on the result list before
// persistScanResults consumes it.
async function applyPerDayCaps(
  results: CompanyResult[],
  baselineSlugs: Set<string>,
): Promise<void> {
  // perDayCaps are GLOBAL scan-throughput limits (not per-user), so
  // we read them from the maintainer's scoring_caps row — the
  // authoritative source for global classifier/scanner knobs.
  const caps = await getScoringCaps(MAINTAINER_USER_ID);
  const globalCap = caps.perDayCaps.maxNewJobsPerDay;
  const companyCap = caps.perDayCaps.maxNewJobsPerCompanyPerDay;
  const todayGlobal = await countNewJobsToday();
  let globalRemaining = Math.max(0, globalCap - todayGlobal);

  if (todayGlobal >= globalCap) {
    // Hard short-circuit: cap already hit across the day, so drop every
    // net-new arrival on this run. Existing-row updates still pass.
    let totalDropped = 0;
    for (const r of results) {
      if (baselineSlugs.has(r.slug)) continue;
      const before = r.matches.length;
      r.matches = r.matches.filter((m) => !m.isNew);
      totalDropped += before - r.matches.length;
    }
    if (totalDropped > 0) {
      console.warn(
        `[scan] global per-day cap reached (${todayGlobal}/${globalCap}) — dropped ${totalDropped} net-new arrivals across all companies`,
      );
    }
    return;
  }

  for (const r of results) {
    if (baselineSlugs.has(r.slug)) continue; // bulk-import slug, exempt
    const newRoles = r.matches.filter((m) => m.isNew);
    if (newRoles.length === 0) continue;

    const todayForCo = await countNewJobsTodayForCompany(r.slug);
    const companyRemaining = Math.max(0, companyCap - todayForCo);
    const headroom = Math.min(globalRemaining, companyRemaining);

    if (newRoles.length <= headroom) {
      globalRemaining -= newRoles.length;
      continue;
    }

    // Truncate: keep the first `headroom` new roles (any deterministic
    // order is fine — they're all from the same scan so ordering is
    // the adapter's natural emission order), drop the rest, log the
    // delta.
    const dropped = newRoles.length - headroom;
    const keepNewIds = new Set(newRoles.slice(0, headroom).map((m) => m.id));
    r.matches = r.matches.filter((m) => !m.isNew || keepNewIds.has(m.id));
    globalRemaining -= headroom;

    console.warn(
      `[scan] ${r.slug}: ${newRoles.length} net-new, dropped ${dropped} ` +
        `(global=${todayGlobal}/${globalCap}, company=${todayForCo}/${companyCap})`,
    );

    if (globalRemaining <= 0) {
      // Hit global cap mid-loop — drop net-new from every remaining
      // result. Existing-row updates still pass through.
      let totalDropped = 0;
      for (const remaining of results.slice(results.indexOf(r) + 1)) {
        if (baselineSlugs.has(remaining.slug)) continue;
        const before = remaining.matches.length;
        remaining.matches = remaining.matches.filter((m) => !m.isNew);
        totalDropped += before - remaining.matches.length;
      }
      if (totalDropped > 0) {
        console.warn(
          `[scan] global per-day cap exhausted — dropped ${totalDropped} additional net-new arrivals from remaining companies`,
        );
      }
      return;
    }
  }
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
      case "workable":
        return await scanWorkableCompany(target, priorIds, isBaseline, vocab);
      default: {
        // Exhaustiveness check: adding a value to the Ats union without
        // adding a case here is a compile error. Prior bug: targets
        // ingested ahead of an adapter deploy slipped through as
        // undefined and crashed downstream where `r.displayName` was
        // read — caller's filter only excluded null, not undefined.
        const _exhaustive: never = target.ats;
        console.error(`[${target.slug}] unknown ats: ${_exhaustive}`);
        return null;
      }
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
  // `!= null` matches both null AND undefined. The narrower `!== null`
  // previously here let a falls-through-the-switch undefined slip into
  // results and crash on `result.displayName`. Belt-and-suspenders with
  // the exhaustiveness check in scanOne's default branch.
  const results = settled.filter((r): r is CompanyResult => r != null);

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

  // Per-day volume caps. Truncates net-new arrivals (m.isNew && not
  // baseline) so a chatty Greenhouse can't burn the entire daily quota
  // on one slug, and the global ceiling rate-limits new-arrival inserts.
  // Existing-row updates (lastSeen, etc.) pass through untouched.
  // Baseline rows pass through untouched — first-scan-of-a-company is
  // intentional bulk import, not net-new discovery.
  await applyPerDayCaps(results, baselineSlugs);

  const levelByMatchId = await persistScanResults(results, baselineSlugs);

  // Phase 4: after global matches are persisted, fan out any newly-
  // inserted rows into per-user user_matches for every subscriber via
  // user_targets. Idempotent — only inserts (user_id, match_id) pairs
  // that don't already exist, so running this every scan is fine.
  // levelByMatchId carries the classifier output through to the
  // fan-out SQL — matches.level no longer exists (Phase 7) so the SQL
  // can't source it from m.*.
  const fanout = await fanOutToUserMatches({}, levelByMatchId);
  if (fanout.inserted > 0) {
    console.log(`[scan] fanned out ${fanout.inserted} new user_matches rows`);
  }

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
