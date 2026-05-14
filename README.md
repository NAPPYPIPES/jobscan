# pub-ats-radar

A self-hosted job scanner. Every hour it pulls public ATS APIs for a list
of companies you configure, classifies each new role against a 5-dimension
rubric anchored to your resume, and emails a daily digest of the strong
matches. Runs on free-tier Vercel / Neon / Resend with Anthropic API spend
capped at ~$2–5/month.

This is a sanitized public template of a working private tool. Twenty
example companies ship with neutral defaults. Drop your resume in, edit
`config/targets.json`, run `npm run ingest-config`, and you're live in
about 45 minutes.

## Screenshots

| Recent matches | AI pro/con analysis | Daily digest |
|---|---|---|
| ![](./screenshots/cards.png) | ![](./screenshots/analysis.png) | ![](./screenshots/digest.png) |

_Capture your own after deploying — these placeholders are gitignored under `screenshots/personal-*`._

## What it does

- Hourly scan of Greenhouse, Ashby, Lever, and Workday job boards
- Two-pass classifier (title rules → description signals) ranks each role BV / HIGH / MEDIUM / LOW
- Claude Sonnet 4.6 scores BV/HIGH/MEDIUM roles on a 5-dimension rubric driven by your parsed resume
- Daily email digest of strong matches via Resend
- On-demand Pro/Con analysis per role via Claude Haiku 4.5
- Manual daily checklist for custom-ATS companies (Google, Meta, Apple…) whose career sites can't be scanned

## Architecture

```
[GitHub Actions cron]
   hourly  → POST /api/cron/scan     (Bearer CRON_SECRET)
   hourly  → POST /api/cron/score
   daily   → POST /api/cron/digest   → Resend → your inbox
        │
        ▼
[Next.js 15 on Vercel]
   adapters/{greenhouse,ashby,lever,workday}   parallel fetch
   filter.ts                                   location + classifier
   fit/score.ts                                Claude rubric scoring
        │
        ▼
[Neon Postgres]
   matches · companies · api_usage · role_summaries · manual_checks · user_profile

[Browser → cookie auth → /, /all, /manual, /docs]
```

## Tech stack

| Layer    | Choice                                                | Why |
|----------|-------------------------------------------------------|-----|
| Frontend | Next.js 15 App Router · Tailwind v4 · React 19 server components | Tiny page-load JS; cookies + middleware handle auth with no session store. |
| Database | Neon Postgres + Drizzle ORM                           | Serverless Postgres so Vercel functions connect without a pool tuner. Drizzle for type-safe queries that compile to readable SQL. |
| AI       | Anthropic SDK — Sonnet 4.6 (scoring), Haiku 4.5 (parse + summaries) | Sonnet for rubric judgment; Haiku for structured-output tasks where Sonnet's reasoning depth isn't needed. |
| Email    | Resend                                                | Free tier covers a daily digest forever; one-line SDK. |
| Cron     | GitHub Actions hitting Vercel routes                  | Vercel Hobby caps cron at once-per-day; GitHub Actions gives hourly for free. |

## Engineering notes

A few decisions worth surfacing — they aren't obvious from a glance at the code.

- **Two-pass classifier.** A rules pass on the title produces an initial tier. A second pass over the JD body shifts that tier up or down based on weighted positive / negative signals, with hard caps for known disqualifiers (e.g. "machine learning" pins a misclassified GTM-shaped title to LOW). Sector dispatch routes to separate tech and finserv vocabularies — bank conventions ("MD, Sales" is senior) differ from tech.
- **Decoupled scan / score / digest.** Three independent cron endpoints. A slow Claude call can't break the discovery cadence: scoring runs with a per-invocation row limit and a wall-clock budget so it never blows past Vercel's 60s function timeout. Backlog clears across hourly ticks.
- **Graceful cost degradation.** Anthropic spend is gated by soft ($35) and hard ($40) monthly caps. At the hard cap, scoring pauses and the classifier still runs — the UI still works, the digest still sends. Every Claude call writes an `api_usage` ledger row; `/docs` graphs daily spend over a configurable window.
- **Idempotent scan.** Rows are keyed by `(ats, slug, job_id)` with an `is_baseline` flag so newly-added companies don't pollute the digest with their entire backlog on first scan. Re-scans update `last_seen` without disturbing the original `first_seen` timestamp.
- **Rubric in config.** The 5-dimension fit-scoring rubric — weights, anchors, hard exclusions, IC role cap, alert threshold — lives in `lib/fit/rubric.ts`. `validateRubric` runs at module load and throws if dimension weights don't sum to 1.0.
- **Resume → user_profile pipeline.** A long-form `docs/resume.md` (gitignored) is parsed by Haiku into a structured `user_profile` row. The 300-word `parsed_summary` field is injected into both the scoring system prompt and the pro/con prompt — no hardcoded candidate context anywhere in the code.
- **Workday acknowledged as best-effort.** Workday's list endpoint returns title + location + jobId but no description. The adapter scaffold ships with the limitation called out in code and docs: Workday roles get rule-based classification only. Per-job description hydration via Apify or a headless browser would be a separate add-on.

Built with [Claude Code](https://claude.com/product/claude-code) as a pair programmer. Architecture, scope, and review were the author's call; the AI handled the typing.

## Getting started

```bash
git clone https://github.com/<you>/pub-ats-radar
cd pub-ats-radar
npm install

# Fill in env vars — see .env.example
cp .env.example .env.local

# Drop your resume in (gitignored)
cp docs/resume.example.md docs/resume.md
$EDITOR docs/resume.md

# Schema → DB
npx drizzle-kit push

# Optionally swap in your real config (gitignored locally). All four
# *.example.json files in config/ are templates; copying them to
# the non-example name and editing customizes your install.
cp config/targets.example.json         config/targets.json
cp config/manual-companies.example.json config/manual-companies.json
cp config/workday-tenants.example.json  config/workday-tenants.json
cp config/personal-keywords.example.json config/personal-keywords.json
# (edit each as needed)

# Ingest config into DB — running app reads from DB, not JSON
npm run ingest-config

# Parse the resume into the user_profile table (~$0.01)
npm run ingest-resume

# Optional: seed one-sentence company descriptions for the scoring prompt
npm run populate-companies -- --write

# Sanity-check every target slug returns jobs
npm run validate-ats

npm run dev
```

Full deployment walkthrough — Vercel env, GitHub Actions secrets, cron wiring — in [`SETUP.md`](./SETUP.md).

## Configuration

Personal data — target companies, manual checklist, classifier keywords
— is stored in the database, not in files at runtime. The committed
`config/*.example.json` files are **seed templates** + schema docs;
the running app reads from DB tables populated by
`npm run ingest-config`.

Flow for any config change:

```bash
# 1. Edit the gitignored local override (copy from .example.json the first time)
$EDITOR config/targets.json

# 2. Push it into the DB
npm run ingest-config

# Production: the same DATABASE_URL points at the same Neon DB, so
# the next cold start picks up the new rows automatically. Nothing
# to redeploy and no env vars to manage per-config.
```

| Knob              | Source file (gitignored)         | DB table             | What's in it |
|-------------------|----------------------------------|----------------------|--------------|
| Target companies  | `config/targets.json`            | `targets`            | Greenhouse / Ashby / Lever / Workday slugs, sector, stage. |
| Manual checklist  | `config/manual-companies.json`   | `manual_companies`   | Custom-ATS companies with pre-filtered careers URLs. |
| Workday tenants   | `config/workday-tenants.json`    | `workday_tenants`    | Per-tenant host + board map (varies per company). |
| Personal keywords | `config/personal-keywords.json`  | `personal_keywords`  | BV phrases, healthcare exclusion, hard-cap regex, finserv bonus regex. |
| Scoring rubric    | `lib/fit/rubric.ts`              | _(in code)_          | Dimension weights, anchors, IC cap, alert threshold. |
| Location filter   | `lib/scan/filter.ts`             | _(in code)_          | `isInScope` defaults to NYC + US-remote. |
| Company logos     | `lib/scan/logos.ts`              | _(in code)_          | Slug → primary domain for favicon-based logos (not sensitive). |

## Costs

| Service        | Monthly |
|----------------|---------|
| Vercel Hobby   | $0      |
| Neon free      | $0      |
| Resend free    | $0      |
| Anthropic API  | ~$2–5 (hard-capped at $40) |
| GitHub Actions | $0 (well inside free minutes on public repos) |
| **Total**      | **~$2–5/month** |

## Out of scope

- Bypassing sites that block automated access (LinkedIn, Indeed)
- Auto-applying to roles
- Multi-user — single password, single resume, single inbox
- Mobile-first UI (works on mobile, designed for desktop)

## Roadmap

- Test suite around the title classifier — the most rule-dense file in the codebase.
- Compact row variant for `/all` once a long-running install accumulates a few hundred open roles.
- Optional Workday description hydration via Apify, behind a flag, for users willing to pay for it.
- Weekly "what got dismissed and why" report to drive classifier tuning.

## License

[MIT](./LICENSE).
