// POST /api/onboarding/targets/add
// Body (one of):
//   { kind: "supported", normalizedName: string }
//   { kind: "manual",    normalizedName: string }
//   { kind: "request",   query: string }
//
// "supported"  → user picked a catalog entry we can auto-scan. Ensures
//                the company is in the global `targets` table, then
//                adds to user_targets. Caps at 20 per user.
// "manual"     → user accepted the "this is a custom careers site"
//                upsell. Ensures the company is in `manual_companies`
//                (with placeholder description + sector), then adds to
//                user_manual_companies. Caps at 10 per user.
// "request"    → user typed a name we don't have. Queues into
//                target_requests for the maintainer to triage.

import { NextResponse } from "next/server";
import { and, count, eq } from "drizzle-orm";
import { getViewerUserId } from "@/lib/auth/viewer";
import { getDb } from "@/db/client";
import {
  atsCatalog,
  manualCompanies,
  targetRequests,
  targets,
  userManualCompanies,
  userTargets,
} from "@/db/schema";
import type { Ats } from "@/lib/scan/types";
import { fanOutToUserMatches } from "@/lib/scan/fanout";

export const runtime = "nodejs";

const MAX_TARGETS = 20;
const MAX_MANUAL = 10;
const MAX_REQUEST_LEN = 100;

const SUPPORTED_ATS = new Set<Ats>(["greenhouse", "ashby", "lever", "workday", "workable"]);

export async function POST(req: Request) {
  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { kind?: unknown; normalizedName?: unknown; query?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const kind = body.kind;
  const db = getDb();

  if (kind === "supported") {
    const name = typeof body.normalizedName === "string" ? body.normalizedName : "";
    if (!name) return NextResponse.json({ error: "normalizedName required" }, { status: 400 });

    // Look up catalog entry.
    const catRows = await db
      .select()
      .from(atsCatalog)
      .where(eq(atsCatalog.normalizedName, name))
      .limit(1);
    const cat = catRows[0];
    if (!cat) return NextResponse.json({ error: "Company not in catalog" }, { status: 404 });
    if (!cat.supported || !cat.slug) {
      return NextResponse.json({ error: "This company isn't auto-scannable. Add as a manual check-in instead." }, { status: 400 });
    }
    if (!SUPPORTED_ATS.has(cat.ats as Ats)) {
      return NextResponse.json({ error: `ATS '${cat.ats}' isn't supported.` }, { status: 400 });
    }

    // Cap check.
    const [{ n: existingCount }] = await db
      .select({ n: count() })
      .from(userTargets)
      .where(eq(userTargets.userId, userId));
    if (Number(existingCount) >= MAX_TARGETS) {
      return NextResponse.json(
        { error: `Already at ${MAX_TARGETS}-target cap.` },
        { status: 409 },
      );
    }

    // Ensure the global targets row exists. The scanner iterates this
    // table, so a target the catalog knows about but the watchlist
    // doesn't won't be polled until it lands here.
    await db
      .insert(targets)
      .values({
        slug: cat.slug,
        ats: cat.ats as Ats,
        displayName: cat.canonicalName,
        addedByUserId: userId,
      })
      .onConflictDoNothing();

    // Add to user's watchlist.
    await db
      .insert(userTargets)
      .values({ userId, targetSlug: cat.slug })
      .onConflictDoNothing();

    // Backfill user_matches for every currently-open match at this
    // target. The fan-out helper sets is_baseline=true on any match
    // whose first_seen predates user_targets.created_at (now) — so
    // adding Anthropic doesn't make 50 existing roles look like
    // "new in the last 24h". Net-new matches arriving at the next
    // scan will fan out with is_baseline=false.
    await fanOutToUserMatches({ userId, targetSlug: cat.slug });

    return NextResponse.json({ ok: true });
  }

  if (kind === "manual") {
    const name = typeof body.normalizedName === "string" ? body.normalizedName : "";
    if (!name) return NextResponse.json({ error: "normalizedName required" }, { status: 400 });

    const catRows = await db
      .select()
      .from(atsCatalog)
      .where(eq(atsCatalog.normalizedName, name))
      .limit(1);
    const cat = catRows[0];
    if (!cat) return NextResponse.json({ error: "Company not in catalog" }, { status: 404 });

    // Cap check.
    const [{ n: existingCount }] = await db
      .select({ n: count() })
      .from(userManualCompanies)
      .where(eq(userManualCompanies.userId, userId));
    if (Number(existingCount) >= MAX_MANUAL) {
      return NextResponse.json(
        { error: `Already at ${MAX_MANUAL} manual check-in cap.` },
        { status: 409 },
      );
    }

    // Ensure the global manual_companies row exists. description /
    // sector are NOT NULL — for user-created entries we seed with
    // placeholders the maintainer can edit later via psql.
    await db
      .insert(manualCompanies)
      .values({
        name: cat.canonicalName,
        careersUrl: cat.careersUrl ?? "",
        description: "(user-added — pending review)",
        sector: "other",
      })
      .onConflictDoNothing();

    await db
      .insert(userManualCompanies)
      .values({ userId, manualCompanyName: cat.canonicalName })
      .onConflictDoNothing();

    return NextResponse.json({ ok: true });
  }

  if (kind === "request") {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > MAX_REQUEST_LEN) {
      return NextResponse.json(
        { error: `query required (max ${MAX_REQUEST_LEN} chars)` },
        { status: 400 },
      );
    }
    await db.insert(targetRequests).values({ userId, query });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
}

// Silence unused-helper warning: `and` is exported from drizzle-orm
// and re-imported here so future cap/dedup queries that need
// combined predicates can reuse it without re-import.
void and;
