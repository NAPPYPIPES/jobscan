import { notInArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { workdayTenants, type WorkdayTenantRow } from "./schema";

// Per-tenant Workday config. See lib/scan/adapters/workday.ts for the
// host/board discovery process — these values aren't derivable from
// the slug.
export type WorkdayConfig = { host: string; board: string };

// Cache the in-flight PROMISE, not the resolved value. Pages call
// jobUrl() per match row inside Promise.all — with a value cache,
// every Workday row on a cold function misses simultaneously and
// each fires its own Neon query. Sharing the promise collapses that
// stampede to one query. Cleared on rejection so a transient DB
// error doesn't poison the cache.
let cached: Promise<Record<string, WorkdayConfig>> | null = null;

async function loadFresh(): Promise<Record<string, WorkdayConfig>> {
  const db = getDb();
  const rows = await db.select().from(workdayTenants);
  const map: Record<string, WorkdayConfig> = {};
  for (const r of rows) {
    map[r.slug] = { host: r.host, board: r.board };
  }
  return map;
}

// Returns the slug → {host, board} map. Empty object if nothing
// ingested — callers (the adapter + URL builder) check for that and
// fall back appropriately.
export function getWorkdayBoards(): Promise<Record<string, WorkdayConfig>> {
  if (!cached) {
    cached = loadFresh().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

// Build the POST /jobs API endpoint for a Workday tenant. Returns
// null if the slug isn't configured — callers treat this as a
// fail-fast bug (every Workday target must have a config entry).
export async function workdayApiUrl(slug: string): Promise<string | null> {
  const boards = await getWorkdayBoards();
  const cfg = boards[slug];
  if (!cfg) return null;
  return `https://${slug}.${cfg.host}.myworkdayjobs.com/wday/cxs/${slug}/${cfg.board}/jobs`;
}

// Replace the entire workday_tenants table.
//
// Upsert-then-prune pattern (see db/targets.ts for full rationale).
export async function replaceWorkdayTenants(
  rows: Array<{ slug: string; host: string; board: string }>,
): Promise<WorkdayTenantRow[]> {
  const db = getDb();
  const slugs = rows.map((r) => r.slug);

  if (rows.length > 0) {
    await db
      .insert(workdayTenants)
      .values(
        rows.map((r) => ({
          slug: r.slug,
          host: r.host,
          board: r.board,
          updatedAt: sql`now()`,
        })),
      )
      .onConflictDoUpdate({
        target: workdayTenants.slug,
        set: {
          host: sql`excluded.host`,
          board: sql`excluded.board`,
          updatedAt: sql`now()`,
        },
      });
  }

  if (slugs.length > 0) {
    await db.delete(workdayTenants).where(notInArray(workdayTenants.slug, slugs));
  } else {
    await db.delete(workdayTenants);
  }

  const final = await db.select().from(workdayTenants);
  const map: Record<string, WorkdayConfig> = {};
  for (const r of final) map[r.slug] = { host: r.host, board: r.board };
  cached = Promise.resolve(map);
  return final;
}
