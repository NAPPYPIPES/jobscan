import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { applyDescriptionShift, classifyRole, isInScope } from "./filter";
import {
  LEVEL_ORDER,
  type CompanyResult,
  type Level,
  type MatchOut,
  type RawJob,
  type Target,
} from "./types";

// Shared post-fetch pipeline used by every ATS adapter: location filter
// → classify → sort → count breakdown → mark new vs prior → assemble
// CompanyResult. Adapters only handle ATS-specific fetching and
// normalize to RawJob before calling in.
//
// `vocab` is the loaded personal-keyword pack from
// db/personal-keywords. The caller (runScanAndPersist) fetches it once
// per scan run and threads it through; this keeps classifyRole +
// applyDescriptionShift as pure functions with no module-load DB I/O.
export function buildCompanyResult(args: {
  target: Target;
  scannedAt: string;
  totalJobs: number;
  rawJobs: RawJob[];
  priorIds: Set<string> | undefined;
  isBaseline: boolean;
  vocab: LoadedPersonalKeywords;
}): CompanyResult {
  const { target, scannedAt, totalJobs, rawJobs, priorIds, isBaseline, vocab } = args;

  const locationMatches = rawJobs.filter((j) => isInScope(j.location));

  const classified = locationMatches
    .map((j) => {
      const titleLevel = classifyRole(j.title, target.sector ?? "tech", j.location, vocab);
      if (titleLevel === null) return { j, level: null };
      // Apply description signal shift if the adapter provided a
      // description (Greenhouse / Ashby / Lever do; Workday doesn't).
      // Returns null if a downgrade drops the role below LOW.
      const finalLevel = applyDescriptionShift(
        titleLevel,
        j.description,
        target.sector ?? "tech",
        vocab,
      );
      return { j, level: finalLevel };
    })
    .filter((x): x is { j: RawJob; level: Level } => x.level !== null)
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  const counts: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const { level } of classified) counts[level]++;

  const matches: MatchOut[] = classified.map(({ j, level }) => ({
    id: j.id,
    level,
    title: j.title,
    location: j.location,
    isNew: isBaseline ? false : !(priorIds?.has(j.id) ?? false),
    description: j.description,
  }));

  return {
    slug: target.slug,
    displayName: target.displayName,
    ats: target.ats,
    scannedAt,
    total: totalJobs,
    locationMatchCount: locationMatches.length,
    levelBreakdown: counts,
    newCount: matches.filter((m) => m.isNew).length,
    matches,
  };
}
