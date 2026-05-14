import { notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { targets, type Target } from "./schema";
import type { CompanyStage, Sector } from "@/lib/scan/types";
import { DEMO_SLUGS } from "@/lib/auth/demo-allowlist";
import type { Role } from "@/lib/auth/cookie";

// Module-memory cache of the targets list, mirroring db/profile.ts.
// Targets change rarely (only when the user re-runs
// `npm run ingest-config`); the cache resets on every cold start so a
// re-deploy or function recycle picks up the latest.
let cached: {
  rows: Target[];
  bySlug: Map<string, Target>;
  sectorBySlug: Map<string, Sector>;
  stageBySlug: Map<string, CompanyStage>;
} | null = null;

function buildIndex(rows: Target[]) {
  const bySlug = new Map<string, Target>();
  const sectorBySlug = new Map<string, Sector>();
  const stageBySlug = new Map<string, CompanyStage>();
  for (const r of rows) {
    bySlug.set(r.slug, r);
    sectorBySlug.set(r.slug, (r.sector ?? "tech") as Sector);
    if (r.stage) stageBySlug.set(r.slug, r.stage as CompanyStage);
  }
  return { rows, bySlug, sectorBySlug, stageBySlug };
}

async function loadFresh() {
  const db = getDb();
  const rows = await db.select().from(targets);
  return buildIndex(rows);
}

// Fetch the watchlist. Returns an array sorted insertion-order by DB
// (which is undefined for Postgres — callers that need a stable order
// should sort by displayName themselves). The full row shape matches
// db/schema.ts's `Target`.
//
// `opts.role`: pass 'demo' to filter to the curated demo allowlist;
// omit (or pass 'owner') to get the full set. Filtering is post-cache
// since the underlying rows don't differ by role — same DB state, two
// views.
export async function getTargets(opts: { role?: Role } = {}): Promise<Target[]> {
  if (!cached) cached = await loadFresh();
  if (opts.role === "demo") {
    return cached.rows.filter((r) => DEMO_SLUGS.has(r.slug));
  }
  return cached.rows;
}

// Slug → sector helper. Returns "tech" for unknown slugs to match the
// classifier's default dispatch. Async on first call (DB round trip),
// sub-ms on cache hits.
export async function sectorForSlug(slug: string): Promise<Sector> {
  if (!cached) cached = await loadFresh();
  return cached.sectorBySlug.get(slug) ?? "tech";
}

// Slug → stage helper. Returns null for unknown slugs or slugs without
// a stage. Used by the fit-scoring rubric's stage dimension.
export async function stageForSlug(slug: string): Promise<CompanyStage | null> {
  if (!cached) cached = await loadFresh();
  return cached.stageBySlug.get(slug) ?? null;
}

// Fail fast if two targets share a slug — schema makes slug the PK so
// this can't actually happen from the DB side, but the ingest script
// might be handed a JSON with duplicate slugs and we want a loud error
// rather than a silent last-write-wins.
export function validateTargets(rows: Pick<Target, "slug">[]): void {
  const seen = new Set<string>();
  for (const t of rows) {
    if (seen.has(t.slug)) {
      throw new Error(`Duplicate slug in targets: "${t.slug}" — slugs must be unique`);
    }
    seen.add(t.slug);
  }
}

// Replace the entire targets table. Used by scripts/ingest-config.ts.
//
// Upsert-then-prune (not DELETE-then-INSERT): the neon-http driver
// doesn't support multi-statement transactions, so we can't wrap a
// DELETE+INSERT pair atomically. Instead we INSERT … ON CONFLICT first
// (table is never empty — old rows persist alongside new ones during
// the brief window), then DELETE any rows whose slug isn't in the new
// set. Worst case if the script crashes mid-write: targets is a
// superset of the desired state, never a subset. The empty-config
// guardrail in runScanAndPersist never fires spuriously.
//
// targets.json is the source of truth; rows in DB but not in the
// incoming list are stale and get pruned. If you want upsert-only
// semantics in the future, add a `--no-prune` flag.
export async function replaceTargets(
  rows: Array<{
    slug: string;
    ats: Target["ats"];
    displayName: string;
    sector?: Sector | null;
    stage?: CompanyStage | null;
  }>,
): Promise<Target[]> {
  validateTargets(rows);
  const db = getDb();
  const slugs = rows.map((r) => r.slug);

  // Empty incoming set is treated as a delete-all (caller is opting
  // into a clean wipe). Skip the insert step.
  if (rows.length > 0) {
    await db
      .insert(targets)
      .values(
        rows.map((r) => ({
          slug: r.slug,
          ats: r.ats,
          displayName: r.displayName,
          sector: r.sector ?? null,
          stage: r.stage ?? null,
          updatedAt: sql`now()`,
        })),
      )
      .onConflictDoUpdate({
        target: targets.slug,
        set: {
          ats: sql`excluded.ats`,
          displayName: sql`excluded.display_name`,
          sector: sql`excluded.sector`,
          stage: sql`excluded.stage`,
          updatedAt: sql`now()`,
        },
      });
  }

  // Prune rows not present in the incoming set. Done after the
  // upsert so there's no point where the table is empty.
  if (slugs.length > 0) {
    await db.delete(targets).where(notInArray(targets.slug, slugs));
  } else {
    await db.delete(targets);
  }

  const final = await db.select().from(targets);
  cached = buildIndex(final);
  return final;
}
