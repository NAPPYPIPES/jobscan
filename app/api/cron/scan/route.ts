import { NextResponse } from "next/server";
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

  try {
    const summary = await runScanAndPersist();
    return NextResponse.json(summary);
  } catch (err) {
    console.error("Scan failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
