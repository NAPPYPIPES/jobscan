// Tier-1 → Tier-2 escalation policy. Pure function from Tier-1 result +
// caps + Sonnet-cap-status to an escalation decision. Lives outside
// triage.ts so the policy is testable in isolation (no model calls
// needed) and so the rules are easy to audit.
//
// Decision tree (highest priority first):
//   1. is_potential_bv=true AND forceEscalateOnPotentialBv:
//        → escalate (unless Sonnet cap → "potential_bv_capped")
//   2. Sonnet cap reached (not BV path):
//        → no escalate, reason "sonnet_cap_reached"
//   3. tier1_score >= scoreFloorAlways (any confidence):
//        → escalate
//   4. confidence='high' AND tier1_score >= highConfidenceFloor:
//        → escalate
//   5. confidence='medium' AND tier1_score >= mediumConfidenceFloor:
//        → escalate
//   6. Otherwise:
//        → no escalate, reason "below_thresholds"
//
// Reason codes are written to logs so every escalation decision is
// grep-able. See triage.ts for the audit-log format.

import type { ScoringCaps } from "@/lib/config/scoring-caps-types";

export type Tier1Result = {
  tier1_score: number;
  confidence: "low" | "medium" | "high";
  quick_take: string;
  is_potential_bv: boolean;
};

export type EscalationReason =
  | "potential_bv"
  | "high_score_any_conf"
  | "medium_score_high_conf"
  | "medium_score_med_conf"
  | "below_thresholds"
  | "sonnet_cap_reached"
  | "potential_bv_capped";

export type EscalationDecision = {
  escalate: boolean;
  reason: EscalationReason;
};

export function decideEscalation(
  tier1: Tier1Result,
  caps: ScoringCaps,
  sonnetCapReached: boolean,
): EscalationDecision {
  const t = caps.haikuToSonnetThresholds;

  // Rule 1: BV detection is privileged. If Haiku flagged is_potential_bv,
  // we must verify with Sonnet (per the design — BV assignment cannot
  // happen without Sonnet verification). If Sonnet cap is hit, persist
  // as HIGH with pending_bv_verification flag so the next cron tick can
  // pick it up when budget allows.
  if (tier1.is_potential_bv && t.forceEscalateOnPotentialBv) {
    if (sonnetCapReached) {
      return { escalate: false, reason: "potential_bv_capped" };
    }
    return { escalate: true, reason: "potential_bv" };
  }

  // Rule 2: Score cap reached and we don't have a BV justification —
  // skip escalation. Caller persists Haiku result with MEDIUM ceiling.
  if (sonnetCapReached) {
    return { escalate: false, reason: "sonnet_cap_reached" };
  }

  const s = tier1.tier1_score;
  const c = tier1.confidence;

  // Rule 3: above-the-line for any confidence — strong Haiku signal.
  if (s >= t.scoreFloorAlways) {
    return { escalate: true, reason: "high_score_any_conf" };
  }
  // Rule 4: high confidence — trust Haiku more, lower the bar.
  if (c === "high" && s >= t.highConfidenceFloor) {
    return { escalate: true, reason: "medium_score_high_conf" };
  }
  // Rule 5: medium confidence — Haiku has more uncertainty, raise the bar.
  if (c === "medium" && s >= t.mediumConfidenceFloor) {
    return { escalate: true, reason: "medium_score_med_conf" };
  }
  // Rule 6: low confidence falls through. scoreFloorAlways already
  // covers high-scoring low-conf cases above.
  return { escalate: false, reason: "below_thresholds" };
}

// Derive a level for rows that don't escalate to Sonnet. HIGH and BV
// require Sonnet verification per the design — without it, Haiku's
// score buckets at LOW or MEDIUM only. The 5.5 cutoff aligns with the
// default high-confidence floor: anything Haiku scores below 5.5 isn't
// a fit signal worth surfacing as MEDIUM.
import type { Level } from "@/lib/scan/types";
export function levelFromTier1(tier1Score: number): Level {
  if (tier1Score >= 5.5) return "MEDIUM";
  return "LOW";
}
