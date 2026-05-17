# CLAUDE.md

Context for Claude Code sessions in this repo. Read this before making
changes.

## What this is

`pub-ats-radar` — a self-hosted job scanner. Hourly cron pulls public
ATS APIs (Greenhouse, Ashby, Lever, Workday), classifies roles against
a rubric anchored to the user's resume, emails a daily digest.
Next.js 15 on Vercel, Postgres on Neon, Resend for email, Anthropic
for scoring + summaries.

It's meant to be forked and self-hosted: each user runs the same
codebase against their own Neon DB, with personal data kept out of git
via the example-JSON + DB ingestion pattern described below. There is
no separate private fork — the public repo IS the production code.

## Critical: public / private boundary

Three categories of data, each handled differently.

**In code (committed, public):**

- All TypeScript / TSX
- Schema (`db/schema.ts`)
- Generic classifier vocabulary (engineering skips, GTM tokens,
  finserv non-GTM skips, etc. — in `lib/scan/filter.ts`)
- Logos map (`lib/scan/logos.ts`) — favicons are public knowledge
- `config/*.example.json` — neutral defaults that double as **seed
  data for first ingestion** and **schema documentation** of the
  shape `npm run ingest-config` expects

**Personal config (gitignored on disk; never on Vercel filesystem):**

- `config/targets.json` — your real target company list
- `config/manual-companies.json` — your real manual checklist
- `config/workday-tenants.json` — your real Workday host+board map
- `config/personal-keywords.json` — your classifier overrides
  (BV phrases, healthcare hard exclusion, hard-cap regex,
  finserv-bonus regex)
- `.env.local` — Neon URL, Anthropic key, Resend key, AUTH_SECRET, etc.
- `docs/resume.md` — long-form resume parsed into `user_profile`
- `scripts/private/` — optional personal tools

**In the database (Neon — single source of truth at runtime):**

- `targets` — what to scan (populated from `config/targets.json`)
- `manual_companies` — daily checklist (from `config/manual-companies.json`)
- `workday_tenants` — per-tenant Workday config (from `config/workday-tenants.json`)
- `personal_keywords` — classifier overrides (from `config/personal-keywords.json`)
- `scoring_caps` — cost-control caps for the two-tier AI funnel (from `config/scoring-caps.json`; also editable live from `/docs`)
- `user_profile` — parsed resume + raw markdown (from `docs/resume.md` via `npm run ingest-resume`)
- `matches` — scan results, applied/dismissed state, Tier-1 fields (`tier1_score`, `tier1_confidence`, `tier1_is_potential_bv`, `tier1_quick_take`), Sonnet's `bv_reasoning`, `pending_bv_verification` flag
- `companies` — one-sentence Claude-generated descriptions
- `api_usage` — cost ledger (`purpose` distinguishes `triage`/`score`/`summary`/`company_description`/`resume_parse`)
- `role_summaries` — cached pro/con analyses
- `manual_checks` — daily-checklist click history

## The ingestion model

The JSON files are **not read by the running app**. They're read once
by `scripts/ingest-config.ts`, which writes them to the DB. Then the
app reads only from DB.

```
config/targets.json   ─┐
config/manual-...json ─┤   npm run ingest-config   ┌─→  DB tables
config/workday-...json ┤  ─────────────────────→   ┤   (targets, manual_companies, ...)
config/personal-..json ┘                           │
                                                   ▼
                                            app reads from DB
                                            (cached in module memory)
```

Flow for any config change:

1. Edit the relevant `config/<name>.json` (gitignored, on your laptop).
2. Run `npm run ingest-config` (writes to whichever DB
   `DATABASE_URL` points at).
3. Cold-restart the next Vercel function call to pick up the new
   cached value (or just wait — module cache resets on cold start).

## Why this design (do not re-add the file loader)

A prior version used `lib/config/load.ts` with a three-tier env-var →
local-file → bundled-example fallback. **It was deliberately removed
in favor of pure DB-backed config.** Reasons:

- Production (Vercel) has no filesystem for personal overrides, so
  the env-var path was the only thing prod actually used.
- Three resolution paths meant three places to debug when something
  was wrong.
- DB-backed gives one source of truth: dev and prod both read the
  same rows from the same `DATABASE_URL`.

**If you're tempted to re-introduce the env-var override path or the
file-at-runtime loader, stop and ask the maintainer first.** This is
a load-bearing architectural decision, not an oversight.

## Override pattern, current shape

`db/<name>.ts` for each of the four config tables. All mirror
`db/profile.ts`:

```ts
// db/<name>.ts
let cached: T | null = null;

export async function getX(): Promise<T> {
  if (cached) return cached;
  cached = await loadFreshFromDb();
  return cached;
}

export async function replaceX(rows): Promise<T> {
  // Upsert-then-prune (NOT DELETE-then-INSERT). neon-http doesn't
  // support multi-statement transactions, so we INSERT ... ON CONFLICT
  // first (table is never empty — old rows persist alongside new ones
  // during the brief overlap), then DELETE rows whose key isn't in
  // the incoming set. Worst-case crash leaves a superset of the
  // desired state, never an empty table. Empty-config guardrails
  // never fire spuriously.
  await db.insert(table).values(...).onConflictDoUpdate(...);
  await db.delete(table).where(notInArray(table.key, newKeys));
  cached = ...; // refresh local cache
  return cached;
}
```

Past design note: an earlier iteration used `db.transaction(...)`
around DELETE+INSERT. neon-http doesn't support that — discovered the
hard way during the first prod ingest. Don't propose adding it back
unless you've already swapped the driver to neon-serverless (which
adds connection-pool complexity not worth the trade for a personal
tool).

The classifier (`lib/scan/filter.ts`) is now a **pure function** that
takes its vocab as an argument. The caller (`lib/scan/run.ts`)
pre-fetches keywords once at the top of a scan run and threads them
down through `buildCompanyResult` → `classifyRole` /
`applyDescriptionShift`.

`lib/scan/urls.ts → jobUrl(...)` is async — needs `getWorkdayBoards()`
for the workday branch. Module cache makes hot calls sub-ms.

## Before committing, always

Run `git status`. If any of these appear in the staged or untracked
column, **stop**:

- `.env*` (except `.env.example`)
- `docs/resume.md`
- `config/*.json` *without* the `.example` suffix
- Anything under `scripts/private/`

`.gitignore` already covers these but verify before push.

## Common workflows

| Task                                | How |
|-------------------------------------|-----|
| Add a new target company            | Edit `config/targets.json` → `npm run ingest-config` → `npm run validate-ats`. Update `lib/scan/logos.ts` for the favicon. |
| Update the resume                   | Edit `docs/resume.md` → `npm run ingest-resume`. |
| Tune the scoring rubric             | Edit `lib/fit/rubric.ts`. Weights must sum to 1.0. |
| Tweak classifier vocab (personal)   | Edit `config/personal-keywords.json` → `npm run ingest-config`. |
| Tweak classifier vocab (generic)    | Edit `lib/scan/filter.ts` directly — these stay in code. |
| Apply a schema change               | Edit `db/schema.ts` → `npx drizzle-kit generate` → apply the new migration. Never edit a migration after it's been applied. |
| First-time setup                    | `drizzle-kit push` → `ingest-config` → `ingest-resume` → `populate-companies --write` → `dev`. |

## Empty-config guardrail

`runScanAndPersist` short-circuits with a warning if `targets` is
empty — a fresh forker who skipped `ingest-config` would otherwise
have the scanner silently do nothing every hour. The log line tells
them exactly what to do.

`personal_keywords` being empty is fine — classification just falls
back to generic vocabulary, no warning needed.

## Stack summary (for fresh-agent context)

- **Frontend**: Next.js 15 App Router, React 19 server components,
  Tailwind v4
- **Backend**: Vercel serverless functions, GitHub Actions cron
  (hourly scan/score, daily digest)
- **DB**: Neon Postgres, Drizzle ORM
- **AI**: Anthropic SDK — Sonnet 4.6 for fit scoring, Haiku 4.5 for
  resume parsing and pro/con summaries
- **Auth**: single password (`PERSONAL_PASS`) + HMAC-signed session
  cookie (`AUTH_SECRET`), edge middleware on every non-cron route

## Known boundaries / gotchas

- **Legacy schema columns (only relevant if you upgraded from an
  earlier internal version).** If you carried over a database that
  had a `matches.list` column or `ats = 'smartrecruiters'` rows, the
  current code ignores both. `matches.list` can be dropped at your
  convenience (`ALTER TABLE matches DROP COLUMN list`); SR rows can
  be deleted (`DELETE FROM matches WHERE ats = 'smartrecruiters'`).
  Fresh installs (`drizzle-kit push` from clean) don't have these.
- **Workday hydration cost.** Workday's list endpoint doesn't return
  descriptions; the adapter does a bounded N+1 against the per-job
  endpoint for roles that already passed isInScope + the title-level
  classifier. The hydrated description feeds both
  `applyDescriptionShift` (scan-time) and the AI fit-scorer (scoring
  tier — `fetchDescription` re-fetches on demand). For Workday
  tenants the in-scope + classify-passing subset is typically 10–40
  roles per tenant, so the extra HTTP fan-out is fine hourly. See
  `lib/scan/adapters/workday.ts` header.
- **Client / server boundary.** Anything pulling `db/*` or
  `lib/scan/{filter,urls,adapters/*,run,core}` is server-only.
  Client components import only types or pre-computed primitives
  passed as props. See `app/page.tsx` for the sector-dict +
  applyUrl enrichment pattern.

## Useful files for orientation

- `db/schema.ts` — entire DB shape
- `db/profile.ts`, `db/targets.ts` — template for the cached-getter +
  transactional-replacer pattern
- `scripts/ingest-config.ts` — config → DB
- `lib/scan/run.ts` — top-level scan orchestration (and the empty-
  config guardrail)
- `lib/scan/filter.ts` — classifier (pure, takes vocab arg)
- `lib/fit/score.ts` — Claude scoring path + cap handling
- `lib/fit/rubric.ts` — configurable rubric
- `app/api/cron/*` — cron entry points
- `.github/workflows/cron.yml` — schedule definitions
