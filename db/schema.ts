import { pgTable, uuid, text, timestamp, unique, boolean, integer, numeric, index, date, jsonb, primaryKey } from "drizzle-orm/pg-core";
import type { Ats, CompanyStage, Level, Sector } from "@/lib/scan/types";
import type { ScoringCaps } from "@/lib/config/scoring-caps-types";

// ──────────────────────────────────────────────────────────────────────
// Auth tables — owned by @auth/drizzle-adapter (NextAuth v5 / Auth.js).
// ──────────────────────────────────────────────────────────────────────
// The four tables below — users, accounts, sessions, verificationTokens —
// follow the shape the Drizzle adapter expects out of the box (see
// https://authjs.dev/getting-started/adapters/drizzle). DO NOT rename
// columns or change types unless you're also passing a custom mapping
// to DrizzleAdapter(...).
//
// We use JWT session strategy (not DB sessions) so the middleware can
// run on Edge — auth() in Edge can't hit the DB. The sessions table is
// kept for completeness in case we ever switch.
//
// The seeded "maintainer" row (Luke) uses a deterministic UUID so the
// dev and prod DBs converge; see lib/auth/maintainer.ts.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
});

export type AuthUser = typeof users.$inferSelect;
export type NewAuthUser = typeof users.$inferInsert;

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// App-specific per-user state, one-to-one with users. Kept separate from
// the NextAuth `users` table so the adapter's expected shape stays clean
// and our app fields don't collide with future adapter additions.
//
// passwordHash: bcrypt hash for Credentials provider. Null when the user
// only uses OAuth (Google).
// monthlyCapUsd: per-user Claude API monthly spend ceiling. Maintainer
// gets a high cap (999.00) to preserve current single-user behavior.
// onboardingCompletedAt: middleware/layout reads this to redirect new
// users to /onboarding until they've finished the wizard.
export const userExtras = pgTable("user_extras", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash"),
  monthlyCapUsd: numeric("monthly_cap_usd", { precision: 8, scale: 2 })
    .notNull()
    .default("5.00"),
  isMaintainer: boolean("is_maintainer").notNull().default(false),
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  digestEmail: text("digest_email"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserExtras = typeof userExtras.$inferSelect;
export type NewUserExtras = typeof userExtras.$inferInsert;

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

// Global catalog of every job posting any user is tracking. Per-user
// state (level, status, fit_score, tier1_*, etc.) lives on
// `user_matches`; matches.* holds only the global facts about a posting
// (title, ATS, location, first/last/closed timestamps). Phase 7
// removed the legacy per-user columns from this table.
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ats: text("ats").$type<Ats>().notNull(),
    companySlug: text("company_slug").notNull(),
    companyDisplayName: text("company_display_name").notNull(),
    jobId: text("job_id").notNull(),
    title: text("title").notNull(),
    location: text("location").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    // True when the row was inserted as part of a slug's first-ever scan
    // (i.e., a newly-added TARGET) rather than a genuine net-new posting
    // at an existing target. Per-user user_matches.is_baseline propagates
    // from this flag at fan-out time; kept here too so brand-new users
    // can be baselined against the full current catalog on signup.
    isBaseline: boolean("is_baseline").notNull().default(false),
    // Set by the scanner when a previously-seen row stops being returned
    // by its ATS — i.e., the listing closed. Cleared back to null on
    // upsert if the same (ats, slug, job_id) reappears in a later scan
    // (rare, but happens). Only set for slugs whose scan succeeded in
    // the run that detected the absence; a fetch failure leaves
    // closed_at untouched so a broken API doesn't auto-close everything
    // for that company. Read paths default to closed_at IS NULL so
    // /all and the digest exclude closed rows automatically.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same job across scans = same row. Re-scan updates last_seen, not inserts.
    unique("matches_ats_slug_jobid_unique").on(t.ats, t.companySlug, t.jobId),
  ],
);

// `Match` is the shape every UI consumer expects: global match fields
// (title, ats, first_seen, closed_at, ...) merged with the viewer's
// per-user state from user_matches (level, status, fit_score, tier1_*,
// is_baseline, ...). Every read path in db/matches.ts JOINs the two
// tables and returns this shape; defining the type as the union of
// both inferSelects keeps it locked to the schema instead of a
// hand-maintained duplicate.
//
// Conflict-resolving Omits: isBaseline + updatedAt exist on both
// tables, and the JOIN reads the user_matches value (per-user flags
// override global). The Omits on matches.* drop those collisions so
// the merged type takes them from user_matches.
type GlobalMatchFields = Omit<typeof matches.$inferSelect, "isBaseline" | "updatedAt">;
type PerUserMatchFields = Omit<typeof userMatches.$inferSelect, "userId" | "matchId" | "createdAt">;
export type Match = GlobalMatchFields & PerUserMatchFields;
export type NewMatch = typeof matches.$inferInsert;

// Cost ledger for the Claude fit-scoring feature. One row per Claude API
// call. The pre-call sum-of-month against this table gates the API call
// against the soft / hard monthly spend caps.
// `purpose` distinguishes fit-scoring calls from on-demand pro/con
// summary calls so /docs can break the spend ledger out by purpose.
//   - "triage":              Tier-1 Haiku call on every new role
//   - "score":               Tier-2 Sonnet deep-scoring on escalated roles
//   - "summary":             on-demand Pro/Con summary (Haiku)
//   - "company_description": one-off Claude call when seeding companies
//   - "resume_parse":        one-off Haiku call when ingesting resume
export type ApiUsagePurpose =
  | "triage"
  | "score"
  | "summary"
  | "company_description"
  | "resume_parse";

export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    matchId: uuid("match_id").references(() => matches.id),
    // Phase 2 multi-tenant addition. Backfilled to maintainer for
    // historical rows; populated by lib/fit/score.ts for new rows after
    // Phase 5 rewires the scoring path. Indexed for per-user MTD spend
    // aggregation (lib/fit/spendCaps.ts).
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    costUsd: numeric("cost_usd", { precision: 8, scale: 6 }).notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").$type<ApiUsagePurpose>().notNull().default("score"),
  },
  (t) => [
    index("api_usage_called_at_idx").on(t.calledAt),
    index("api_usage_user_called_at_idx").on(t.userId, t.calledAt),
  ],
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
    // Phase 2 multi-tenant addition. The legacy
    // manual_checks_company_date_unique constraint (one row per
    // (company, date)) stays in place during Phase 2 since the
    // maintainer is the only user — Phase 5 swaps it for a
    // user-scoped (user_id, company, check_date) constraint once
    // app code passes user_id on every write.
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
    index("manual_checks_user_date_idx").on(t.userId, t.checkDate),
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
  // Phase 2 multi-tenant addition. Backfilled to maintainer for
  // historical rows. The match_id PK is preserved during Phase 2 (one
  // summary per match still) — Phase 5 swaps to a composite
  // (user_id, match_id) PK so each user can have their own resume-
  // tailored summary of the same role.
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  // Phase 2 multi-tenant addition. UNIQUE constraint enforces one
  // profile per user; Phase 3 onboarding inserts one row per new user;
  // Phase 5 rewrites db/profile.ts to look up by userId.
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
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
  // Phase 2 multi-tenant addition. Attribution-only — records which
  // user first asked us to track this company. The actual watchlist
  // membership lives in user_targets (one row per (user_id, slug)).
  // Nullable because legacy rows have no provenance; backfilled to
  // maintainer for those.
  addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
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
  // Phase 2 multi-tenant addition. UNIQUE constraint enforces one
  // keyword row per user; Phase 5 rewrites db/personal-keywords.ts to
  // look up by userId.
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  bvPhrases: jsonb("bv_phrases").$type<string[]>().notNull().default([]),
  healthcareSkips: jsonb("healthcare_skips").$type<string[]>().notNull().default([]),
  hardCapLowPatterns: jsonb("hard_cap_low_patterns").$type<string[]>().notNull().default([]),
  finservBonusPositivePatterns: jsonb("finserv_bonus_positive_patterns").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PersonalKeywordsRow = typeof personalKeywords.$inferSelect;
export type NewPersonalKeywordsRow = typeof personalKeywords.$inferInsert;

// Cost-control caps for the two-tier scoring funnel. Single-row table
// (key='default' for the single-user case, matching user_profile's
// pattern). Stored as JSONB so adding a knob doesn't require a
// schema migration. Type defined in lib/config/scoring-caps-types.ts;
// db/scoring-caps.ts wraps this with cached getter + replacer + the
// validation function that runs before each write.
export const scoringCaps = pgTable("scoring_caps", {
  key: text("key").primaryKey().default("default"),
  // Phase 2 multi-tenant addition. UNIQUE constraint enforces one
  // caps row per user; Phase 5 rewrites db/scoring-caps.ts to look up
  // by userId and at that point the legacy `key` column gets dropped.
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<ScoringCaps>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ScoringCapsRow = typeof scoringCaps.$inferSelect;
export type NewScoringCapsRow = typeof scoringCaps.$inferInsert;

// ──────────────────────────────────────────────────────────────────────
// Multi-tenant join + lookup tables (Phase 2)
// ──────────────────────────────────────────────────────────────────────
// These tables exist alongside (not instead of) the existing targets /
// manual_companies / matches catalog. Targets, manual_companies, and
// matches stay GLOBAL — one row per real-world entity — and per-user
// state lives in the join tables below. See plans/now-i-want-to-...
// for the full tenancy rationale.

// Per-user watchlist. Cap: 20 entries per user enforced at the API
// layer in Phase 3 onboarding. The target_slug FK guarantees we don't
// orphan watchlist entries for a deleted target.
export const userTargets = pgTable(
  "user_targets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetSlug: text("target_slug")
      .notNull()
      .references(() => targets.slug, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.targetSlug] }),
    index("user_targets_target_idx").on(t.targetSlug),
  ],
);

export type UserTarget = typeof userTargets.$inferSelect;
export type NewUserTarget = typeof userTargets.$inferInsert;

// Per-user manual check-in list. Cap: 10 entries per user enforced at
// the API layer in Phase 3 onboarding. References manual_companies.name
// rather than embedding a name string so the catalog stays the source
// of truth for careers URL + description.
export const userManualCompanies = pgTable(
  "user_manual_companies",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    manualCompanyName: text("manual_company_name")
      .notNull()
      .references(() => manualCompanies.name, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.manualCompanyName] })],
);

export type UserManualCompany = typeof userManualCompanies.$inferSelect;
export type NewUserManualCompany = typeof userManualCompanies.$inferInsert;

// Per-user state for every match the user has visibility into. Phase 4
// fan-out inserts one row here for each (user_targets, matches) pair.
// During Phase 2-3, the app still reads per-user state from the
// matches.* columns; Phase 5-6 swap reads/writes to this table; Phase
// 7 drops the redundant matches.* columns.
//
// All per-user state fields mirror the matches.* originals so the
// Phase 2 backfill is a straight column copy.
export const userMatches = pgTable(
  "user_matches",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    level: text("level").$type<Level>().notNull(),
    status: text("status").$type<MatchStatus>().notNull().default("new"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissReason: text("dismiss_reason").array().$type<DismissReason[]>(),
    fitScore: numeric("fit_score", { precision: 3, scale: 1 }),
    fitSummary: text("fit_summary"),
    fitFlag: text("fit_flag"),
    tier1Score: numeric("tier1_score", { precision: 3, scale: 1 }),
    tier1Confidence: text("tier1_confidence"),
    tier1IsPotentialBv: boolean("tier1_is_potential_bv"),
    tier1QuickTake: text("tier1_quick_take"),
    pendingBvVerification: boolean("pending_bv_verification").notNull().default(false),
    bvReasoning: text("bv_reasoning"),
    // Per-user baseline flag. True when this row was inserted as part
    // of the user's first-ever exposure to a target (either at scan
    // time via lib/scan/run.ts when baselineSlugs.has(slug), or at
    // onboarding/add-target time when we backfill the user against
    // all currently-open matches for that target). Hidden from
    // "new in the last 24h" filters and digest emails so adding a
    // company doesn't flood the user with hundreds of "new" roles.
    isBaseline: boolean("is_baseline").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.matchId] }),
    index("user_matches_user_status_idx").on(t.userId, t.status),
    index("user_matches_user_level_idx").on(t.userId, t.level),
  ],
);

export type UserMatch = typeof userMatches.$inferSelect;
export type NewUserMatch = typeof userMatches.$inferInsert;

// Catalog of known companies + their ATS classification. Powers
// onboarding's "add a target" combobox: a user types "google" → we
// look up the normalized name and decide whether to add to user_targets
// (supported), suggest user_manual_companies (manual), or queue a
// target_requests row (unknown).
//
// ats values:
//   greenhouse | ashby | lever | workday  — supported = true
//   manual                                — supported = false
//   unsupported                           — supported = false (known but unscannable)
export const atsCatalog = pgTable(
  "ats_catalog",
  {
    // Lowercased + punctuation-stripped key. Lookups normalize the
    // user-typed query the same way before searching.
    normalizedName: text("normalized_name").primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    ats: text("ats").notNull(),
    // Slug used by the ATS adapter when ats is supported; null
    // otherwise. For Greenhouse this is the boards token, for Workday
    // it pairs with workday_tenants for host/board lookup.
    slug: text("slug"),
    careersUrl: text("careers_url"),
    supported: boolean("supported").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type AtsCatalogRow = typeof atsCatalog.$inferSelect;
export type NewAtsCatalogRow = typeof atsCatalog.$inferInsert;

// Queue of "we don't recognize this company name" requests from
// onboarding. Maintainer reviews periodically and either: (a) adds the
// company to targets + ats_catalog if it has a supported ATS, (b) adds
// to manual_companies + ats_catalog if it doesn't, or (c) leaves it
// alone. The user sees a "we'll add it to our queue" message and can
// proceed with onboarding.
export const targetRequests = pgTable(
  "target_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("target_requests_user_idx").on(t.userId)],
);

export type TargetRequest = typeof targetRequests.$inferSelect;
export type NewTargetRequest = typeof targetRequests.$inferInsert;
