import { NextResponse } from "next/server";
import { gt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userExtras } from "@/db/schema";
import { scoreUnscoredEligibleForUser } from "@/lib/fit/score";

// Decoupled scoring endpoint. Runs the two-tier funnel (Haiku triage
// then optional Sonnet escalation) on unscored eligible rows per user,
// plus the pending-BV-verification auto-pickup. Phase 5: now loops
// every onboarded user with a non-zero monthly cap; each gets a slice
// of the time budget so one user with a big backlog can't starve
// others.
//
// Triggered by the same cron workflow as /api/cron/scan, chained as
// the second curl step. See .github/workflows/cron.yml.
export const maxDuration = 60;

// Bumped 2026-05-25: 8/45s was leaving a chronic 200+ row unscored
// backlog (drain rate < add rate even when cron fired reliably). With
// 25/55s a typical tick processes 10-18 rows depending on description
// fetch latency, still well under the function's 60s ceiling. The
// caller's monthly spend cap (scoring_caps.monthlyCapsUsd.score) is the
// real budget guardrail — at $35/mo we have headroom for ~700 Sonnet
// scores, far beyond what hourly add-rate produces.
const PER_USER_BATCH_LIMIT = 25;
const TOTAL_TIME_BUDGET_MS = 55_000;

export async function GET(req: Request) {
  // Same bearer-auth pattern as /api/cron/scan. Locally CRON_SECRET
  // is unset and auth is skipped.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();

    // Eligible users: have completed onboarding (so their resume is
    // in user_profile) AND have a non-zero monthly cap (so we have
    // budget to spend on them). Demo user has cap=0 — excluded.
    const eligible = await db
      .select({ userId: userExtras.userId })
      .from(userExtras)
      .where(
        sql`${userExtras.onboardingCompletedAt} IS NOT NULL AND ${userExtras.monthlyCapUsd} > 0`,
      );

    if (eligible.length === 0) {
      return NextResponse.json({ users: 0, totals: { scored: 0, triagedOnly: 0, skipped: 0, errored: 0 } });
    }

    // Round-robin the time budget so a user with 500 pending rows
    // doesn't starve everyone else. Per-user budget is total/N,
    // floored at 5s so each user still gets a meaningful slice.
    const perUserBudget = Math.max(5_000, Math.floor(TOTAL_TIME_BUDGET_MS / eligible.length));
    const startedAt = Date.now();

    const totals = {
      scored: 0,
      triagedOnly: 0,
      pendingBvProcessed: 0,
      skipped: 0,
      errored: 0,
      remaining: 0,
    };

    for (const { userId } of eligible) {
      if (Date.now() - startedAt >= TOTAL_TIME_BUDGET_MS) break;
      const result = await scoreUnscoredEligibleForUser(userId, {
        limit: PER_USER_BATCH_LIMIT,
        timeBudgetMs: perUserBudget,
      });
      totals.scored += result.scored;
      totals.triagedOnly += result.triagedOnly;
      totals.pendingBvProcessed += result.pendingBvProcessed;
      totals.skipped += result.skipped;
      totals.errored += result.errored;
      totals.remaining += result.remaining;
    }

    return NextResponse.json({ users: eligible.length, totals });
  } catch (err) {
    console.error("Score endpoint failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

// drizzle-orm exports `gt` / `isNotNull`; left imported in case future
// tweaks to the eligibility predicate switch from the raw sql template
// to drizzle's typed helpers.
void gt;
void isNotNull;
