// Per-day volume cap counters. Enforced at scan-ingestion time before
// inserting new matches rows. Two caps: global (across all companies)
// and per-company. Both counted from matches.first_seen >= UTC midnight
// — matching the month boundary in spendCaps.ts so the dashboard's
// timezone story stays consistent.
//
// Roles dropped due to caps aren't lost permanently — the scanner is
// incremental, so any role still posted at the ATS next tick gets
// re-discovered. The cap rate-limits new-arrival inserts, not
// discovery.

import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { matches } from "@/db/schema";

// UTC day boundary. Match getCurrentMonthSpend() and checkSpend() in
// spendCaps.ts so caps + spend reset on the same clock.
function todayUtcStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function countNewJobsToday(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matches)
    .where(gte(matches.firstSeen, todayUtcStart()));
  return rows[0]?.n ?? 0;
}

export async function countNewJobsTodayForCompany(slug: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matches)
    .where(
      and(eq(matches.companySlug, slug), gte(matches.firstSeen, todayUtcStart())),
    );
  return rows[0]?.n ?? 0;
}

export type DayCapHeadroom = {
  globalToday: number;
  globalCap: number;
  companyToday: number;
  companyCap: number;
  // Minimum of (globalCap - globalToday) and (companyCap - companyToday).
  // <= 0 means cap is hit and caller should drop remaining new roles.
  headroom: number;
};

// One-shot check returning headroom against both caps for a slug.
// Caller truncates new-role inserts to this number. Returns 0 when
// either cap is fully hit.
export async function dayCapHeadroom(
  slug: string,
  globalCap: number,
  companyCap: number,
): Promise<DayCapHeadroom> {
  const [globalToday, companyToday] = await Promise.all([
    countNewJobsToday(),
    countNewJobsTodayForCompany(slug),
  ]);
  const headroom = Math.max(
    0,
    Math.min(globalCap - globalToday, companyCap - companyToday),
  );
  return { globalToday, globalCap, companyToday, companyCap, headroom };
}
