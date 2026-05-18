// Per-user monthly spend cap tracking. Phase 5 made these helpers
// per-user — every call now takes userId. The cap structure derives
// from user_extras.monthly_cap_usd (one number) via an apportionment:
//
//   total   = userMonthlyCap          (master kill-switch)
//   triage  = userMonthlyCap × 0.30   (Haiku triage budget)
//   score   = userMonthlyCap × 0.60   (Sonnet deep-score budget)
//   summary = userMonthlyCap × 0.10   (on-demand Pro/Con summary)
//
// Maintainer has cap=999 (set in migration 0003) so the apportioned
// per-purpose caps are huge ($300/$600/$100) and effectively
// unlimited — preserves the pre-Phase-5 maintainer experience.
//
// New users default to $5/mo → $1.50/$3/$0.50 per purpose. Restrictive
// for free MVP — heavy scoring would need the maintainer to bump the
// cap in DB (or, later, Stripe upgrade).
//
// resume_parse + company_description don't have per-purpose caps;
// they only respect the total cap. (Both are one-shot ingestion paths.)

import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, userExtras } from "@/db/schema";

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

const APPORTION = {
  triage: 0.3,
  score: 0.6,
  summary: 0.1,
} as const;

// Returns the start of the current calendar month in UTC.
function monthUtcStart(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Per-user MTD spend lookup. One query, two sums (purpose-specific +
// total). The cap derivation reads user_extras.monthly_cap_usd; if
// the row is missing (shouldn't happen post-onboarding), default to
// $0 so every call short-circuits — safer than picking a magic
// number that might burn unexpected spend.
export async function checkSpend(
  userId: string,
  purpose: Purpose,
): Promise<SpendStatus> {
  const db = getDb();
  const start = monthUtcStart();

  const sumRows = await db
    .select({
      purposeSpent: sql<string>`coalesce(sum(case when ${apiUsage.purpose} = ${purpose} then ${apiUsage.costUsd} else 0 end), 0)::text`,
      totalSpent: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text`,
    })
    .from(apiUsage)
    .where(and(eq(apiUsage.userId, userId), gte(apiUsage.calledAt, start)));

  const spent = parseFloat(sumRows[0]?.purposeSpent ?? "0");
  const totalSpent = parseFloat(sumRows[0]?.totalSpent ?? "0");

  const capRows = await db
    .select({ cap: userExtras.monthlyCapUsd })
    .from(userExtras)
    .where(eq(userExtras.userId, userId))
    .limit(1);
  const totalCap = parseFloat(capRows[0]?.cap ?? "0");

  // resume_parse + company_description fall back to Infinity so they
  // only feel the total-cap pressure, not a per-purpose ceiling.
  const fraction = APPORTION[purpose as keyof typeof APPORTION];
  const cap =
    fraction == null ? Number.POSITIVE_INFINITY : totalCap * fraction;

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

// Convenience for the auto-pickup path: is Sonnet (score purpose)
// cap or the total cap reached for this user? Used by escalation.ts
// callers to decide whether Tier-2 is available right now.
export async function isSonnetCapReached(userId: string): Promise<boolean> {
  const status = await checkSpend(userId, "score");
  return status.capReached || status.totalCapReached;
}
