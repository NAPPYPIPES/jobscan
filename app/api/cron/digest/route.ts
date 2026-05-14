import { NextResponse } from "next/server";
import { getRecentAlertCandidates } from "@/db/matches";
import { sendDigest, type AlertRow } from "@/lib/alerts/email";
import { shouldAlert, type FitFlag } from "@/lib/fit/score";
import { sectorForSlug } from "@/db/targets";
import { jobUrl } from "@/lib/scan/urls";

// Pure DB read + send — no scan triggered here. Hourly scans (cron
// hitting /api/cron/scan) keep first_seen accurate. This endpoint
// queries the last 48h and splits into a today (0-24h) and yesterday
// (24-48h) section. Sends every day at whatever cadence the cron
// hits this URL regardless of whether either section has matches —
// reliable daily ping.
export const maxDuration = 30;

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK_24 = 24 * HOUR_MS;
const LOOKBACK_48 = 48 * HOUR_MS;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const now = Date.now();
    const since48 = new Date(now - LOOKBACK_48);
    const cutoff24 = new Date(now - LOOKBACK_24);

    const candidates = await getRecentAlertCandidates(since48);

    // sectorForSlug + jobUrl are both async now (DB lookups behind
    // module-memory cache). Resolve each row in parallel; the cache
    // makes the second-onwards calls sub-ms.
    const rows: AlertRow[] = await Promise.all(
      candidates.map(async (m) => ({
        level: m.level,
        title: m.title,
        companyDisplayName: m.companyDisplayName,
        location: m.location,
        url: await jobUrl(m.ats, m.companySlug, m.jobId),
        firstSeen: m.firstSeen,
        sector: await sectorForSlug(m.companySlug),
        fitScore: m.fitScore != null ? parseFloat(m.fitScore) : null,
        fitSummary: m.fitSummary,
        fitFlag: m.fitFlag as FitFlag | null,
      })),
    );

    const alertable = rows.filter((r) =>
      shouldAlert({ level: r.level, fitScore: r.fitScore, fitFlag: r.fitFlag }),
    );
    const today = alertable.filter((r) => r.firstSeen >= cutoff24);
    const yesterday = alertable.filter((r) => r.firstSeen < cutoff24);

    const sent = await sendDigest({ today, yesterday });
    return NextResponse.json({
      since: since48.toISOString(),
      todayCount: today.length,
      yesterdayCount: yesterday.length,
      sent,
    });
  } catch (err) {
    console.error("Digest failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
