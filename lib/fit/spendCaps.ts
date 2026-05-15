// Per-purpose monthly spend cap tracking. Replaces the hardcoded
// SOFT/HARD constants in score.ts with config-driven, per-purpose caps
// from db/scoring-caps. Each model call site checks the relevant
// purpose before paying.
//
// `total` is the master kill-switch: every purpose check also returns
// total spend so callers can short-circuit on total cap regardless of
// per-purpose budget.
//
// Overshoot bound: this is check-then-call, so under concurrent runs we
// can overshoot the cap by up to N concurrent calls. For a $40/mo
// personal tool with sequential scan batches, overshoot ≈ 5 × $0.018 =
// ~$0.09 worst case. If it ever matters, swap to a Postgres advisory
// lock around the check + insert. Not worth the complexity here.

import { gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage } from "@/db/schema";
import { getScoringCaps } from "@/db/scoring-caps";

// Five purposes the codebase emits api_usage rows for. Keeps cost
// reporting honest — every Anthropic call must declare its purpose.
export type Purpose =
  | "triage"
  | "score"
  | "summary"
  | "company_description"
  | "resume_parse";

export type SpendStatus = {
  purpose: Purpose;
  spent: number;
  cap: number;
  capReached: boolean;
  totalSpent: number;
  totalCap: number;
  totalCapReached: boolean;
};

// Returns the start of the current calendar month in UTC. Matches the
// month boundary in score.ts's getCurrentMonthSpend(), which the rest
// of the codebase has settled on.
function monthUtcStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Check both the purpose-specific spend and total spend for the month.
// One query, two sums. Caller decides what to do with each flag — see
// the matrix in CLAUDE.md (triage cap → keyword classifier fallback;
// score cap → trust Haiku with MEDIUM ceiling; total cap → hard stop).
//
// Only purposes that have a numeric cap in monthlyCapsUsd return a
// finite `cap`. Purposes without a configured cap (company_description,
// resume_parse — both one-offs that don't have per-purpose budgets)
// fall through with cap=Infinity. They still respect totalCap.
export async function checkSpend(purpose: Purpose): Promise<SpendStatus> {
  const db = getDb();
  const caps = await getScoringCaps();
  const start = monthUtcStart();

  const rows = await db
    .select({
      purposeSpent: sql<string>`coalesce(sum(case when ${apiUsage.purpose} = ${purpose} then ${apiUsage.costUsd} else 0 end), 0)::text`,
      totalSpent: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text`,
    })
    .from(apiUsage)
    .where(gte(apiUsage.calledAt, start));

  const spent = parseFloat(rows[0]?.purposeSpent ?? "0");
  const totalSpent = parseFloat(rows[0]?.totalSpent ?? "0");

  // Per-purpose caps are configured for triage / score / summary only.
  // company_description and resume_parse are one-shot ingestion paths
  // — they only need to respect the total cap.
  const perPurposeCap: Partial<Record<Purpose, number>> = {
    triage: caps.monthlyCapsUsd.triage,
    score: caps.monthlyCapsUsd.score,
    summary: caps.monthlyCapsUsd.summary,
  };
  const cap = perPurposeCap[purpose] ?? Number.POSITIVE_INFINITY;
  const totalCap = caps.monthlyCapsUsd.total;

  return {
    purpose,
    spent,
    cap,
    capReached: spent >= cap,
    totalSpent,
    totalCap,
    totalCapReached: totalSpent >= totalCap,
  };
}

// Convenience for the auto-pickup path: is Sonnet (score purpose) cap
// or the total cap reached? Used by escalation.ts callers to decide
// whether Tier-2 is available.
export async function isSonnetCapReached(): Promise<boolean> {
  const status = await checkSpend("score");
  return status.capReached || status.totalCapReached;
}
