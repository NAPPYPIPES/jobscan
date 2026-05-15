import { NextResponse } from "next/server";
import { scoreUnscoredEligibleFromDb } from "@/lib/fit/score";

// Decoupled scoring endpoint. Runs the two-tier funnel (Haiku triage
// then optional Sonnet escalation) on unscored eligible rows, plus the
// pending-BV-verification auto-pickup. Keeps each invocation under
// Vercel Hobby's 60s function ceiling.
//
// Triggered by the same cron workflow as /api/cron/scan, chained as
// the second curl step. See .github/workflows/cron.yml.
export const maxDuration = 60;

// Batch size: each fresh row is up to one Haiku call (~2s) + maybe one
// Sonnet call (~3-5s). 8 fresh rows worst-case = ~56s — tight against
// 60s ceiling. In practice ~30% escalate so the average is well under
// budget. Backlog clears across hourly ticks.
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
