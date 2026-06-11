import { notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { manualCompanies, type ManualCompanyRow } from "./schema";

// Manual-checklist sector union, kept here so other modules can import
// the type without pulling DB code (it's small). Mirrors the prior
// ManualSector type from the deleted lib/scan/manual-targets.ts.
export type ManualSector = "tech" | "finserv" | "consulting" | "other";

export type ManualCompany = {
  name: string;
  careersUrl: string;
  description: string;
  sector: ManualSector;
};

const VALID_SECTORS: ReadonlySet<string> = new Set([
  "tech",
  "finserv",
  "consulting",
  "other",
]);

// Module-memory cache, same pattern as db/targets.ts: caches the
// in-flight PROMISE so concurrent first calls on a cold function
// share one query. Cleared on rejection.
type ManualIndex = {
  rows: ManualCompany[];
  validNames: Set<string>;
};
let cached: Promise<ManualIndex> | null = null;

function getIndex(): Promise<ManualIndex> {
  if (!cached) {
    cached = loadFresh().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

function toDomain(rows: ManualCompanyRow[]): ManualCompany[] {
  return rows.map((r) => ({
    name: r.name,
    careersUrl: r.careersUrl,
    description: r.description,
    // Coerce to the union; rows with unknown sectors fall to "other"
    // so a corrupt row can't crash the page render.
    sector: (VALID_SECTORS.has(r.sector) ? r.sector : "other") as ManualSector,
  }));
}

async function loadFresh() {
  const db = getDb();
  const rows = await db.select().from(manualCompanies);
  const domain = toDomain(rows);
  return {
    rows: domain,
    validNames: new Set(domain.map((c) => c.name)),
  };
}

// Returns the manual checklist. Empty array if the table hasn't been
// ingested — the /manual page handles that gracefully (shows an empty
// grid with the "checked today" counter at zero).
export async function getManualCompanies(): Promise<ManualCompany[]> {
  return (await getIndex()).rows;
}

// Allowlist used by the POST /api/manual/check route to refuse writes
// for company names that aren't in the configured list. Caches the
// derived Set so repeated calls in a warm function don't rebuild it.
export async function getValidManualCompanies(): Promise<Set<string>> {
  return (await getIndex()).validNames;
}

// Replace the entire manual_companies table.
//
// Upsert-then-prune pattern (see db/targets.ts for full rationale):
// neon-http doesn't support transactions, so we INSERT … ON CONFLICT
// first then DELETE anything not in the new set. Table is never empty.
export async function replaceManualCompanies(
  rows: ManualCompany[],
): Promise<ManualCompany[]> {
  // Validate sectors at write-time so a bad ingest JSON throws here
  // rather than silently falling through to "other" later.
  for (const r of rows) {
    if (!VALID_SECTORS.has(r.sector)) {
      throw new Error(
        `manual_companies: invalid sector "${r.sector}" for "${r.name}" — must be one of ${[...VALID_SECTORS].join(", ")}`,
      );
    }
  }
  const db = getDb();
  const names = rows.map((r) => r.name);

  if (rows.length > 0) {
    await db
      .insert(manualCompanies)
      .values(
        rows.map((r) => ({
          name: r.name,
          careersUrl: r.careersUrl,
          description: r.description,
          sector: r.sector,
          updatedAt: sql`now()`,
        })),
      )
      .onConflictDoUpdate({
        target: manualCompanies.name,
        set: {
          careersUrl: sql`excluded.careers_url`,
          description: sql`excluded.description`,
          sector: sql`excluded.sector`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (names.length > 0) {
    await db.delete(manualCompanies).where(notInArray(manualCompanies.name, names));
  } else {
    await db.delete(manualCompanies);
  }

  const final = await db.select().from(manualCompanies);
  const domain = toDomain(final);
  cached = Promise.resolve({
    rows: domain,
    validNames: new Set(domain.map((c) => c.name)),
  });
  return domain;
}
