// Curated subset of target slugs surfaced to demo-mode viewers. The
// rest of the watchlist is filtered out at every read site (see
// db/matches.ts, db/targets.ts, app/analytics/page.tsx,
// app/docs/page.tsx) so demo viewers see this feels like a small,
// well-known sample rather than the maintainer's full job-search
// scope.
//
// Selection rationale: ~20 widely-recognized tech + finserv names so
// the demo reads as a showcase, plus Snorkel AI explicitly (per
// product ask) + a couple of high-profile AI startups (Glean, Hebbia)
// that round out the AI-tools angle.
//
// Slugs MUST exist in the live `targets` table — otherwise the demo
// view shows fewer companies than expected. Verify against
// scripts/list-targets-tmp.ts (or any equivalent) before adding new
// names.

export const DEMO_SLUGS: ReadonlySet<string> = new Set([
  // Famous AI / dev infrastructure
  "anthropic",
  "openai",
  "vercel",
  "notion",
  "stripe",
  "mongodb",
  "snowflake",
  "databricks",
  "datadog",
  "twilio",
  "mistral",
  "cohere",
  "cursor",
  "replit",
  "scaleai",

  // Explicit per product ask
  "snorkelai",

  // Famous fintech
  "mercury",
  "brex",
  "ramp",
  "plaid",

  // Notable AI-application startups
  "gleanwork",
  "hebbia",
]);

export function isDemoSlug(slug: string): boolean {
  return DEMO_SLUGS.has(slug);
}

// As an array for SQL inArray() calls. Frozen to keep the module-level
// reference stable across the request lifetime (cheaper than rebuilding).
export const DEMO_SLUGS_ARRAY: readonly string[] = Object.freeze(
  Array.from(DEMO_SLUGS),
);
