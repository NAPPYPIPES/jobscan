import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { manualChecks } from "@/db/schema";

// GET /api/manual/status
//
// Returns the most-recent check timestamp per company, across all
// dates, as an ISO string map. The /manual page uses this to compute
// the 5-state staleness ring on each card. Companies that have never
// been checked are absent from the map (treated as "never").
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const rows = await db
    .select({
      company: manualChecks.company,
      checkedAt: manualChecks.checkedAt,
    })
    .from(manualChecks)
    .orderBy(desc(manualChecks.checkedAt));

  const lastChecked: Record<string, string> = {};
  for (const row of rows) {
    if (!lastChecked[row.company]) {
      lastChecked[row.company] = row.checkedAt.toISOString();
    }
  }
  return NextResponse.json({ lastChecked });
}
