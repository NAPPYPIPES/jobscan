import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { runScanAndPersist } from "@/lib/scan/run";

// 20+ parallel ATS fetches + one bulk DB upsert complete in well under
// a minute. Set to Vercel Hobby's max so a slow ATS or DB hiccup has
// headroom.
export const maxDuration = 60;

export async function GET(req: Request) {
  // Bearer-auth: enforced when CRON_SECRET is set, skipped locally.
  // Triggered hourly by GitHub Actions (Vercel Hobby caps Vercel Cron
  // at once-per-day; sub-daily polling lives outside Vercel). Email
  // digest is decoupled — see /api/cron/digest, fired daily.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // runId tags every log line and the response body so a failure can be
  // tied back to a specific cron invocation in Vercel's log explorer.
  // Free-tier Vercel only retains ~30 min of runtime logs, so without a
  // forensic trail in the catch block, intermittent 500s are unrecoverable.
  const runId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  console.log(`[scan ${runId}] start`);

  try {
    const summary = await runScanAndPersist();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[scan ${runId}] ok in ${elapsedMs}ms`);
    return NextResponse.json({ runId, elapsedMs, ...summary });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const name = err instanceof Error ? err.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[scan ${runId}] FAIL after ${elapsedMs}ms — ${name}: ${message}\n${stack ?? "(no stack)"}`,
    );
    return NextResponse.json(
      { runId, elapsedMs, error: { name, message, stack } },
      { status: 500 },
    );
  }
}
