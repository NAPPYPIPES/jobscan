import { NextResponse } from "next/server";
import { gt, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userExtras } from "@/db/schema";
import { scoreUnscoredEligibleForUser } from "@/lib/fit/score";

// Decoupled scoring endpoint. Runs Sonnet against unscored eligible
// rows per user, plus the pending-BV-verification auto-pickup. Phase
// 5: loops every onboarded user with a non-zero monthly cap; each
// gets a slice of the time budget so one user with a big backlog
// can't starve others.
//
// Triggered by the same cron workflow as /api/cron/scan, chained as
// the second curl step. See .github/workflows/cron.yml.
export const maxDuration = 60;

// All-Sonnet path (2026-05-25): every eligible row pays for a
// Sonnet call. Sonnet averages 3-6s per row, so the 55s time budget
// caps real throughput around 10-18 rows/pass regardless of the
// batch limit. The batch limit (50) just prevents over-querying the
// DB when the time budget cuts the work short. The cron workflow
// runs /score 4× per fire (see .github/workflows/cron.yml), so a
// single fire processes ~40-70 rows — comfortably above the
// ~50/week BV+HIGH+MEDIUM add rate that drives this queue.
const PER_USER_BATCH_LIMIT = 50;
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
      return NextResponse.json({ users: 0, totals: { scored: 0, skipped: 0, errored: 0 } });
    }

    // Round-robin the time budget so a user with 500 pending rows
    // doesn't starve everyone else. Per-user budget is total/N,
    // floored at 5s so each user still gets a meaningful slice.
    const perUserBudget = Math.max(5_000, Math.floor(TOTAL_TIME_BUDGET_MS / eligible.length));
    const startedAt = Date.now();

    const totals = {
      scored: 0,
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
