// GET /api/onboarding/targets/search?q=foo
//
// Powers the typeahead in the wizard's targets step. Normalizes the
// query the same way the catalog does (lowercase, strip non-alnum)
// and matches by prefix + by canonical-name substring. Returns up
// to 10 results, sorted with prefix matches first.
//
// Each result includes `alreadyAdded` so the UI can suppress the Add
// button for things the user picked earlier in the session.

import { NextResponse } from "next/server";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { getViewerUserId } from "@/lib/auth/viewer";
import { getDb } from "@/db/client";
import { atsCatalog, userTargets, userManualCompanies } from "@/db/schema";

export const runtime = "nodejs";

const MAX_RESULTS = 10;

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function GET(req: Request) {
  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const url = new URL(req.url);
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length < 2) return NextResponse.json({ results: [] });

  const normalized = normalize(raw);
  const db = getDb();

  // Prefix match on normalized_name OR substring match on
  // canonical_name (so "wells fargo" finds "Wells Fargo" even if the
  // catalog row's normalized form differs from the typed query).
  const rows = await db
    .select({
      normalizedName: atsCatalog.normalizedName,
      canonicalName: atsCatalog.canonicalName,
      ats: atsCatalog.ats,
      slug: atsCatalog.slug,
      careersUrl: atsCatalog.careersUrl,
      supported: atsCatalog.supported,
    })
    .from(atsCatalog)
    .where(
      or(
        ilike(atsCatalog.normalizedName, `${normalized}%`),
        ilike(atsCatalog.canonicalName, `%${raw}%`),
      ),
    )
    .limit(MAX_RESULTS);

  // Tag rows the user has already picked so the UI shows "Added" instead
  // of an Add button.
  const slugs = rows
    .map((r) => r.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const canonicals = rows.map((r) => r.canonicalName);

  const alreadySupported = slugs.length
    ? new Set(
        (
          await db
            .select({ slug: userTargets.targetSlug })
            .from(userTargets)
            .where(
              and(
                eq(userTargets.userId, userId),
                sql`${userTargets.targetSlug} = ANY(${slugs})`,
              ),
            )
        ).map((x) => x.slug),
      )
    : new Set<string>();

  const alreadyManual = canonicals.length
    ? new Set(
        (
          await db
            .select({ name: userManualCompanies.manualCompanyName })
            .from(userManualCompanies)
            .where(
              and(
                eq(userManualCompanies.userId, userId),
                sql`${userManualCompanies.manualCompanyName} = ANY(${canonicals})`,
              ),
            )
        ).map((x) => x.name),
      )
    : new Set<string>();

  // Sort prefix matches first (more relevant) then alphabetic.
  rows.sort((a, b) => {
    const ap = a.normalizedName.startsWith(normalized) ? 0 : 1;
    const bp = b.normalizedName.startsWith(normalized) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.canonicalName.localeCompare(b.canonicalName);
  });

  const results = rows.map((r) => ({
    normalizedName: r.normalizedName,
    canonicalName: r.canonicalName,
    ats: r.ats,
    slug: r.slug,
    careersUrl: r.careersUrl,
    supported: r.supported,
    alreadyAdded: r.supported
      ? r.slug != null && alreadySupported.has(r.slug)
      : alreadyManual.has(r.canonicalName),
  }));

  return NextResponse.json({ results });
}
