import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userExtras } from "@/db/schema";
import { getRecentAlertCandidates } from "@/db/matches";
import { sendDigest, type AlertRow } from "@/lib/alerts/email";
import { shouldAlert, type FitFlag } from "@/lib/fit/score";
import { sectorForSlug } from "@/db/targets";
import { jobUrl } from "@/lib/scan/urls";

// Pure DB read + send — no scan triggered here. Hourly scans (cron
// hitting /api/cron/scan) keep first_seen accurate. This endpoint
// queries the last 48h per user and splits into today (0-24h) +
// yesterday (24-48h). Sends per user regardless of activity (reliable
// daily ping).
//
// Phase 6: loops every onboarded user with digest_enabled=true. Per-
// user candidate fetch + per-user send. Demo user has digest_enabled
// =false (seeded by migration 0005) so they never receive an email
// even if you accidentally bump their cap.
export const maxDuration = 60;

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
    const db = getDb();
    const eligible = await db
      .select({ userId: userExtras.userId })
      .from(userExtras)
      .where(
        and(
          eq(userExtras.digestEnabled, true),
          isNotNull(userExtras.onboardingCompletedAt),
        ),
      );

    if (eligible.length === 0) {
      return NextResponse.json({ users: 0, sent: 0 });
    }

    const now = Date.now();
    const since48 = new Date(now - LOOKBACK_48);
    const cutoff24 = new Date(now - LOOKBACK_24);

    let sent = 0;
    let skipped = 0;
    const perUser: Array<{
      userId: string;
      today: number;
      yesterday: number;
      sent: boolean;
    }> = [];

    for (const { userId } of eligible) {
      const candidates = await getRecentAlertCandidates(userId, since48);

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

      const ok = await sendDigest(userId, { today, yesterday });
      if (ok) sent++;
      else skipped++;
      perUser.push({
        userId,
        today: today.length,
        yesterday: yesterday.length,
        sent: ok,
      });
    }

    return NextResponse.json({
      since: since48.toISOString(),
      users: eligible.length,
      sent,
      skipped,
      perUser,
    });
  } catch (err) {
    console.error("Digest failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
