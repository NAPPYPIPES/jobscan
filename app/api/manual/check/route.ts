import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { manualChecks } from "@/db/schema";
import { getValidManualCompanies } from "@/db/manual-companies";
import { requireOwner } from "@/lib/auth/viewer";

// POST /api/manual/check  body: { company: string }
//
// Records a "user manually checked this company today" event. The
// (company, check_date) unique constraint is the natural per-day key;
// ON CONFLICT DO UPDATE refreshes checked_at on intra-day revisits so
// the staleness ring on /manual reflects the LAST click, not the first.
//
// Auth: provided by the global middleware (par_session cookie).
// Demo viewers are blocked here too — manual-check timestamps would
// otherwise leak demo-viewer activity into the owner's daily-checklist
// staleness signal.
export async function POST(req: Request) {
  const denied = await requireOwner();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const company = (body as { company?: unknown }).company;
  if (typeof company !== "string") {
    return NextResponse.json({ error: "unknown company" }, { status: 400 });
  }
  const validNames = await getValidManualCompanies();
  if (!validNames.has(company)) {
    return NextResponse.json({ error: "unknown company" }, { status: 400 });
  }

  // UTC date as ISO YYYY-MM-DD for the date column.
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();
  await db
    .insert(manualChecks)
    .values({ company, checkDate: today })
    .onConflictDoUpdate({
      target: [manualChecks.company, manualChecks.checkDate],
      set: { checkedAt: sql`now()` },
    });

  return NextResponse.json({ success: true });
}
