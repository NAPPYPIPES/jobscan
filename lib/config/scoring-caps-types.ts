// Type definitions for the two-tier scoring funnel's cost-control caps.
// One row in the scoring_caps table (key='default') stores this shape as
// JSONB. UI on /docs reads + writes via db/scoring-caps.ts.
//
// Lives outside db/schema.ts so the Settings UI client component can
// import the type without pulling drizzle-orm into the client bundle.

export type ScoringCaps = {
  // Pre-AI volume caps. Both are counted from matches.first_seen since
  // today's UTC midnight. perDay = global ceiling; perCompanyPerDay =
  // per-slug ceiling to keep one chatty Greenhouse from eating the
  // entire daily quota.
  perDayCaps: {
    maxNewJobsPerDay: number;
    maxNewJobsPerCompanyPerDay: number;
  };
  // Monthly spend caps, summed against api_usage.cost_usd grouped by
  // api_usage.purpose. `total` is the master kill-switch; if it's hit
  // every model call short-circuits regardless of per-purpose budget.
  monthlyCapsUsd: {
    triage: number;
    score: number;
    summary: number;
    total: number;
  };
  // Tier-1 → Tier-2 escalation policy. Lower scoreFloorAlways → more
  // Sonnet escalations → higher monthly score spend.
  haikuToSonnetThresholds: {
    // Tier-1 score at or above this escalates regardless of confidence.
    scoreFloorAlways: number;
    // Tier-1 score floor for escalation when confidence === "high".
    highConfidenceFloor: number;
    // Tier-1 score floor for escalation when confidence === "medium".
    mediumConfidenceFloor: number;
    // When Haiku flags is_potential_bv = true, force escalation
    // regardless of score (subject to Sonnet cap). Recommended true.
    forceEscalateOnPotentialBv: boolean;
  };
  // What to do when each cap is hit. Centralizing here so the cap-check
  // sites stay simple — they look up the action and apply it.
  behaviorOnCapHit: {
    // When triage spend cap is hit: fall back to the rule-based
    // classifyRole() in lib/scan/filter.ts, or skip the role entirely.
    triageCapFallback: "keyword_classifier" | "skip";
    // When score spend cap is hit: trust Tier-1 result and ceil the
    // level at MEDIUM (HIGH/BV require Sonnet verification), or skip.
    scoreCapFallback: "trust_tier1_max_medium" | "skip";
    // When total spend cap is hit: hard-stop every Claude call this
    // month (triage, score, summary, company_description, resume_parse).
    totalCapFallback: "hard_stop_all_scoring";
  };
};

// Defaults used when scoring_caps table has no row yet (fresh install
// before `npm run ingest-config`). Values match config/scoring-caps.example.json.
export const FALLBACK_CAPS: ScoringCaps = {
  perDayCaps: {
    maxNewJobsPerDay: 100,
    maxNewJobsPerCompanyPerDay: 25,
  },
  monthlyCapsUsd: {
    triage: 5.0,
    score: 35.0,
    summary: 5.0,
    total: 40.0,
  },
  haikuToSonnetThresholds: {
    scoreFloorAlways: 7.0,
    highConfidenceFloor: 5.5,
    mediumConfidenceFloor: 6.5,
    forceEscalateOnPotentialBv: true,
  },
  behaviorOnCapHit: {
    triageCapFallback: "keyword_classifier",
    scoreCapFallback: "trust_tier1_max_medium",
    totalCapFallback: "hard_stop_all_scoring",
  },
};

// Soft validation. Throws on values that would produce nonsense scoring
// behavior (e.g. total cap > $200 — that's user typo not intentional
// budget). The UI also enforces these as min/max attributes on inputs
// but server-side validation backs that up.
export function validateCaps(caps: ScoringCaps): void {
  if (caps.monthlyCapsUsd.total > 200) {
    throw new Error("Total cap > $200 — refusing as guardrail.");
  }
  if (caps.monthlyCapsUsd.total < 1) {
    throw new Error("Total cap < $1 — refusing as guardrail.");
  }
  const purposeSum =
    caps.monthlyCapsUsd.triage +
    caps.monthlyCapsUsd.score +
    caps.monthlyCapsUsd.summary;
  // Allow per-purpose caps to exceed total by up to 10% — accommodates
  // the common case where you set triage=$5, score=$35, summary=$5
  // ($45) but want total=$40 as a hard ceiling. Block obvious typos
  // ($200 of per-purpose against $40 total).
  if (purposeSum > caps.monthlyCapsUsd.total * 1.5) {
    throw new Error(
      `Per-purpose caps sum to $${purposeSum.toFixed(2)} but total is $${caps.monthlyCapsUsd.total.toFixed(2)} — typo?`,
    );
  }
  if (caps.perDayCaps.maxNewJobsPerDay > 500) {
    throw new Error("maxNewJobsPerDay > 500 — refusing as guardrail.");
  }
  if (caps.perDayCaps.maxNewJobsPerDay < 1) {
    throw new Error("maxNewJobsPerDay < 1 — refusing.");
  }
  if (
    caps.perDayCaps.maxNewJobsPerCompanyPerDay >
    caps.perDayCaps.maxNewJobsPerDay
  ) {
    throw new Error(
      "maxNewJobsPerCompanyPerDay cannot exceed maxNewJobsPerDay.",
    );
  }
  const thresholdNumericKeys = [
    "scoreFloorAlways",
    "highConfidenceFloor",
    "mediumConfidenceFloor",
  ] as const;
  for (const k of thresholdNumericKeys) {
    const v = caps.haikuToSonnetThresholds[k];
    if (typeof v !== "number" || v < 0 || v > 10) {
      throw new Error(`haikuToSonnetThresholds.${k} must be in [0, 10].`);
    }
  }
}
