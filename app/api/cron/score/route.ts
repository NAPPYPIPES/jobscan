import { NextResponse } from "next/server";
import { scoreUnscoredEligibleFromDb } from "@/lib/fit/score";

// Decoupled scoring endpoint. Picks up unscored BV/HIGH/MEDIUM rows
// from the DB and Claude-scores them in small bounded batches —
// keeps each invocation comfortably under Vercel Hobby's 60s function
// ceiling. Backlog clears across multiple hourly runs if needed.
//
// Triggered by the same cron workflow as /api/cron/scan, chained as
// the second curl step. See .github/workflows/cron.yml.
export const maxDuration = 60;

const BATCH_LIMIT = 8;
const TIME_BUDGET_MS = 45_000;

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
    const summary = await scoreUnscoredEligibleFromDb({
      limit: BATCH_LIMIT,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    return NextResponse.json(summary);
  } catch (err) {
    console.error("Score endpoint failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
