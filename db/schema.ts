import { pgTable, uuid, text, timestamp, unique, boolean, integer, numeric, index, date, jsonb } from "drizzle-orm/pg-core";
import type { Ats, CompanyStage, Level, Sector } from "@/lib/scan/types";

// Ats and Level live in lib/scan/types.ts — the scan domain is the source
// of truth for those concepts; the DB just persists them. Values are
// stored as text rather than Postgres enums so they're easy to evolve
// without a schema migration; TypeScript narrowing keeps us honest.
export type MatchStatus = "new" | "applied" | "dismissed" | "interested";

// Reason picker captured inline on the card when the user dismisses a
// role. Stored as text[] on matches.dismiss_reason (multi-select —
// e.g. "wrong location" + "wrong function" on the same card). No
// Postgres enum so the option set can evolve without a migration.
// Null when the user dismissed without selecting any reason.
export type DismissReason =
  | "wrong_function"
  | "wrong_level"
  | "wrong_company"
  | "wrong_location"
  | "not_interested";

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ats: text("ats").$type<Ats>().notNull(),
    companySlug: text("company_slug").notNull(),
    companyDisplayName: text("company_display_name").notNull(),
    jobId: text("job_id").notNull(),
    level: text("level").$type<Level>().notNull(),
    title: text("title").notNull(),
    location: text("location").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    // True when the row was inserted as part of a slug's first-ever scan
    // (i.e., a newly-added TARGET) rather than a genuine net-new posting
    // at an existing target. Excludes these rows from "new in last X"
    // counts and the email digest so adding companies doesn't pollute
    // net-new signals.
    isBaseline: boolean("is_baseline").notNull().default(false),
    status: text("status").$type<MatchStatus>().notNull().default("new"),
    // Set when status flips to 'applied', cleared when flipped back to
    // 'new'. Distinct from updatedAt (which any re-scan bumps) so any
    // UI showing "when you actually applied" reads the right thing.
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    // Set when the user dismisses a card. Distinct from status='dismissed'
    // (which still drives main-view visibility) so we can capture the
    // reason picker data without changing existing read paths.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    // Array of DismissReason values. Null when the user dismissed without
    // tagging anything.
    dismissReason: text("dismiss_reason").array().$type<DismissReason[]>(),
    // Set by the scanner when a previously-seen row stops being returned
    // by its ATS — i.e., the listing closed. Cleared back to null on
    // upsert if the same (ats, slug, job_id) reappears in a later scan
    // (rare, but happens). Only set for slugs whose scan succeeded in
    // the run that detected the absence; a fetch failure leaves
    // closed_at untouched so a broken API doesn't auto-close everything
    // for that company. Read paths default to closed_at IS NULL so
    // /all and the digest exclude closed rows automatically.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Claude-API-driven fit score for BV/HIGH/MEDIUM new roles. Populated
    // only when (a) role is BV/HIGH/MEDIUM at first-insert, (b) ATS provides
    // a description (Greenhouse/Ashby/Lever — Workday/SR are skipped),
    // (c) the monthly API spend cap hasn't been hit.
    fitScore: numeric("fit_score", { precision: 3, scale: 1 }),
    fitSummary: text("fit_summary"),
    fitFlag: text("fit_flag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same job across scans = same row. Re-scan updates last_seen, not inserts.
    unique("matches_ats_slug_jobid_unique").on(t.ats, t.companySlug, t.jobId),
  ],
);

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;

// Cost ledger for the Claude fit-scoring feature. One row per Claude API
// call. The pre-call sum-of-month against this table gates the API call
// against the soft / hard monthly spend caps.
// `purpose` distinguishes fit-scoring calls from on-demand pro/con
// summary calls so /docs can break the spend ledger out by purpose.
export type ApiUsagePurpose = "score" | "summary";

export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    matchId: uuid("match_id").references(() => matches.id),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: numeric("cost_usd", { precision: 8, scale: 6 }).notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").$type<ApiUsagePurpose>().notNull().default("score"),
  },
  (t) => [index("api_usage_called_at_idx").on(t.calledAt)],
);

export type ApiUsage = typeof apiUsage.$inferSelect;
export type NewApiUsage = typeof apiUsage.$inferInsert;

// One-sentence company descriptions, used by the scoring path to give
// Claude context on what each company actually sells and to whom.
// Populated once via scripts/populate-company-descriptions.ts.
export const companies = pgTable("companies", {
  slug: text("slug").primaryKey(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

// Per-company "I checked this manually today" log. Backs the /manual
// daily checklist for companies whose careers sites can't be scanned
// automatically. One row per (company, UTC date) — the unique constraint
// + ON CONFLICT DO UPDATE in the POST handler makes intra-day revisits
// refresh the timestamp without growing the row count.
export const manualChecks = pgTable(
  "manual_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    company: text("company").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    // UTC date of the check, stored separately from checked_at so the
    // unique constraint is a clean equality (no date_trunc) and so the
    // GET status query can filter dates without timezone math.
    checkDate: date("check_date").notNull(),
  },
  (t) => [
    unique("manual_checks_company_date_unique").on(t.company, t.checkDate),
    index("manual_checks_check_date_idx").on(t.checkDate),
  ],
);

export type ManualCheck = typeof manualChecks.$inferSelect;
export type NewManualCheck = typeof manualChecks.$inferInsert;

// On-demand AI Pro/Con analysis for BV/HIGH/MEDIUM roles. One row per
// match — overwritten on regenerate so we always hold the latest take.
// promptVersion lets us invalidate the cache after a meaningful prompt
// change without manually purging rows: bumping CURRENT_PROMPT_VERSION
// in lib/fit/summary-prompt.ts makes every cached row look stale to the
// cache-hit query, and the next click regenerates.
export const roleSummaries = pgTable("role_summaries", {
  matchId: uuid("match_id")
    .primaryKey()
    .references(() => matches.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  pros: jsonb("pros").$type<string[]>().notNull(),
  cons: jsonb("cons").$type<string[]>().notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  promptVersion: integer("prompt_version").notNull().default(1),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 8, scale: 6 }),
});

export type RoleSummary = typeof roleSummaries.$inferSelect;
export type NewRoleSummary = typeof roleSummaries.$inferInsert;

// One row holds the user's parsed resume. scripts/ingest-resume.ts
// overwrites on re-run (DELETE all + INSERT new), so updated_at always
// reflects the latest ingestion. parsedSummary is read on every fit-
// scoring call and every Pro/Con summary call — keep it short
// (250-350 words) so it doesn't dominate the prompt budget.
export const userProfile = pgTable("user_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  rawResumeMd: text("raw_resume_md").notNull(),
  parsedSummary: text("parsed_summary").notNull(),
  yearsExperience: integer("years_experience"),
  industries: jsonb("industries").$type<string[]>().notNull().default([]),
  functions: jsonb("functions").$type<string[]>().notNull().default([]),
  seniorityLevel: text("seniority_level"),
  targetRoles: jsonb("target_roles").$type<string[]>().notNull().default([]),
  hardExclusions: jsonb("hard_exclusions").$type<string[]>().notNull().default([]),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserProfile = typeof userProfile.$inferSelect;
export type NewUserProfile = typeof userProfile.$inferInsert;

// ──────────────────────────────────────────────────────────────────────
// Config tables — populated by scripts/ingest-config.ts
// ──────────────────────────────────────────────────────────────────────
// These four tables replace the prior file-loader pattern
// (lib/config/load.ts + config/*.json). The committed
// config/*.example.json files are now seed data + schema documentation;
// the running app reads only from these tables. See
// scripts/ingest-config.ts for the ingestion path.

// Watchlist of companies whose ATS APIs we scan. One row per slug.
// `ats` decides which adapter handles the fetch; `sector` controls
// classifier vocabulary (tech vs finserv); `stage` informs the
// fit-scoring rubric's stage dimension.
export const targets = pgTable("targets", {
  slug: text("slug").primaryKey(),
  ats: text("ats").$type<Ats>().notNull(),
  displayName: text("display_name").notNull(),
  sector: text("sector").$type<Sector>(),
  stage: text("stage").$type<CompanyStage>(),
  // Set by the scanner after a successful per-target fetch — even if
  // the scan returned zero jobs (a successful zero is meaningful: it
  // means the company has no postings, which lets us close stale
  // matches). Stays null until the first successful scan, so a
  // newly-added target reads as "not yet scanned" rather than "failing".
  // The closed-roles + scan-failure detection both key off this.
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Target = typeof targets.$inferSelect;
export type NewTarget = typeof targets.$inferInsert;

// Companies whose careers sites use custom ATSs that can't be scanned
// via Greenhouse/Ashby/Lever/Workday public APIs — visited by hand on
// the /manual daily checklist. Keyed by name (the human-visible label
// the UI shows and the POST /api/manual/check route validates against).
export const manualCompanies = pgTable("manual_companies", {
  name: text("name").primaryKey(),
  careersUrl: text("careers_url").notNull(),
  description: text("description").notNull(),
  // Stored as plain text rather than a $type-narrowed union so the
  // ingest script can validate against the allowed set without forcing
  // a TS-narrowing import cycle through lib/scan/manual-types.
  sector: text("sector").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ManualCompanyRow = typeof manualCompanies.$inferSelect;
export type NewManualCompanyRow = typeof manualCompanies.$inferInsert;

// Per-tenant Workday config. `host` and `board` aren't derivable from
// the slug — see lib/scan/adapters/workday.ts for the discovery
// process. One row per Workday slug; slug also appears in `targets`
// for the actual scan to pick it up.
export const workdayTenants = pgTable("workday_tenants", {
  slug: text("slug").primaryKey(),
  host: text("host").notNull(),
  board: text("board").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkdayTenantRow = typeof workdayTenants.$inferSelect;
export type NewWorkdayTenantRow = typeof workdayTenants.$inferInsert;

// Single-row classifier vocabulary. Replaces lib/scan/filter.ts's
// in-file PERSONAL_KW const. Regex fields are stored as JSONB arrays
// of source strings — getPersonalKeywords() compiles them to RegExp at
// load time, dropping any that fail to parse rather than crashing the
// scan run. DELETE all + INSERT one on every ingestion (mirrors
// user_profile).
export const personalKeywords = pgTable("personal_keywords", {
  id: uuid("id").primaryKey().defaultRandom(),
  bvPhrases: jsonb("bv_phrases").$type<string[]>().notNull().default([]),
  healthcareSkips: jsonb("healthcare_skips").$type<string[]>().notNull().default([]),
  hardCapLowPatterns: jsonb("hard_cap_low_patterns").$type<string[]>().notNull().default([]),
  finservBonusPositivePatterns: jsonb("finserv_bonus_positive_patterns").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PersonalKeywordsRow = typeof personalKeywords.$inferSelect;
export type NewPersonalKeywordsRow = typeof personalKeywords.$inferInsert;
