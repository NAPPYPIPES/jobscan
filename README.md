# pub-ats-radar

A self-hosted job scanner. Every hour it pulls public ATS APIs for a list
of companies you configure, runs each new role through a two-tier AI funnel
(Haiku triage → Sonnet deep-score) anchored to your resume, and emails a
daily digest of the strong matches. Runs on free-tier Vercel / Neon /
Resend with Anthropic API spend capped at ~$10–15/month by default and
fully user-configurable from a settings UI.

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
- Rule-based classifier (title rules → description signals) gives every role a baseline BV / HIGH / MEDIUM / LOW tier
- **Two-tier AI funnel** on the desc-capable rows:
  - **Tier 1 — Haiku 4.5 triage** on every new role (~$0.002/call with prompt caching). Reads title + 600-char snippet + your full resume; returns a 0–10 score, confidence, and an `is_potential_bv` flag for rare exact-match BV titles.
  - **Tier 2 — Sonnet 4.6 deep-score** only for promising roles (configurable thresholds). Five-dimension scoring + an authoritative `level_recommendation` that distinguishes the rare exact-BV match from strong-but-not-BV HIGH fits.
- BV (Business Value) reserved for the candidate's specific career-path match — explicit value-consulting titles at Director-and-above seniority. Strong non-BV fits get HIGH, never BV.
- User-configurable cost caps (per-day volume, per-purpose monthly spend, escalation thresholds) editable from `/docs` settings without redeploy
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
   scan/run.ts                                 per-day volume caps
   scan/filter.ts                              location + rule classifier
   fit/triage.ts                               Tier-1: Haiku triage (cached prompt)
   fit/escalation.ts                           threshold policy → escalate?
   fit/score.ts                                Tier-2: Sonnet deep-score (cached prompt)
   fit/spendCaps.ts                            per-purpose monthly budget guard
        │
        ▼
[Neon Postgres]
   matches (+ tier1_*, bv_reasoning, pending_bv_verification) · companies
   api_usage (purpose: triage|score|summary|…) · role_summaries
   manual_checks · user_profile · scoring_caps · targets · manual_companies
   workday_tenants · personal_keywords

[Browser → cookie auth → /, /all, /manual, /docs (settings)]
```

## Tech stack

| Layer    | Choice                                                | Why |
|----------|-------------------------------------------------------|-----|
| Frontend | Next.js 15 App Router · Tailwind v4 · React 19 server components | Tiny page-load JS; cookies + middleware handle auth with no session store. |
| Database | Neon Postgres + Drizzle ORM                           | Serverless Postgres so Vercel functions connect without a pool tuner. Drizzle for type-safe queries that compile to readable SQL. |
| AI       | Anthropic SDK — Haiku 4.5 (Tier-1 triage on every role, plus resume parse + summaries), Sonnet 4.6 (Tier-2 deep-score on escalated rows). Prompt caching on both. | Haiku-first funnel keeps marginal cost <$0.01 per role on average. Sonnet only on the promising 25–35% that benefit from its reasoning depth. |
| Email    | Resend                                                | Free tier covers a daily digest forever; one-line SDK. |
| Cron     | GitHub Actions hitting Vercel routes                  | Vercel Hobby caps cron at once-per-day; GitHub Actions gives hourly for free. |

## Engineering notes

A few decisions worth surfacing — they aren't obvious from a glance at the code.

- **Two-tier AI funnel + rule-based classifier as backstop.** The rule classifier still gives every role a baseline tier (cheap, deterministic, runs on Workday rows that have no JD). On top of it, Haiku triages every desc-capable role and Sonnet deep-scores only those that clear configurable thresholds. The funnel exists because a single-tier Sonnet pass on every new role was either expensive (~$0.018/role × 100/day) or noisy (running it only on rule-classified BV/HIGH missed the roles the rules got wrong). Haiku at 10× lower cost reads every role; Sonnet only sees the candidates worth its reasoning depth. Sector dispatch in the rule pass routes to separate tech and finserv vocabularies — bank conventions ("MD, Sales" is senior) differ from tech.
- **BV is rare by design.** Both prompts spell out that BV (Business Value) is reserved for the candidate's exact career-path match — explicit value-consulting / value-engineering titles at Director-and-above seniority. Strong fits that aren't BV-specific (VP GTM, Director of Enterprise Sales, etc.) are HIGH, never BV. Sonnet returns `level_recommendation` directly and a `bv_reasoning` quote when assigning BV, making every BV call auditable in the DB.
- **Prompt caching is load-bearing.** Both Tier-1 and Tier-2 mark the system block (resume + rubric + level rules) as `cache_control: ephemeral`. With caching warm, Haiku triage costs ~$0.002/call instead of ~$0.025. Without it the cost math breaks. Cold cache costs $0.075–$0.30 per cache write — amortizes across a batch.
- **Decoupled scan / score / digest.** Three independent cron endpoints. A slow Claude call can't break the discovery cadence: scoring runs with a per-invocation row limit and a wall-clock budget so it never blows past Vercel's 60s function timeout. Backlog clears across hourly ticks.
- **Cost controls in the database, editable from the UI.** A `scoring_caps` table holds per-day volume caps (jobs/day, jobs/company/day), per-purpose monthly spend caps (triage, score, summary, total), and the Tier-1 → Tier-2 escalation thresholds. `/docs` has a Settings section that reads and writes this row directly — no redeploy needed. When the triage cap is hit, the pipeline falls back to the rule classifier; when the score cap is hit, Haiku results are persisted with the level capped at MEDIUM; the total cap is the master kill-switch. Every Claude call writes an `api_usage` row with its `purpose` so the dashboard can break spend out by tier.
- **Pending-BV auto-pickup.** If Haiku flags `is_potential_bv = true` but the Sonnet budget is exhausted, the row persists as HIGH with `pending_bv_verification = true`. The next score tick (or the next month) auto-picks up these rows for retroactive Sonnet verification — so BV candidates can't get stranded by a cap.
- **Idempotent scan.** Rows are keyed by `(ats, slug, job_id)` with an `is_baseline` flag so newly-added companies don't pollute the digest with their entire backlog on first scan. Re-scans update `last_seen` without disturbing the original `first_seen` timestamp. Per-day caps truncate net-new arrivals only — existing-row updates always pass.
- **Rubric in config.** The 5-dimension fit-scoring rubric — weights, anchors, hard exclusions, IC role cap, alert threshold — lives in `lib/fit/rubric.ts`. `validateRubric` runs at module load and throws if dimension weights don't sum to 1.0.
- **Resume → user_profile pipeline.** A long-form `docs/resume.md` (gitignored) is parsed by Haiku into a structured `user_profile` row that also stores the raw markdown. Both prompts pull the full resume text from there at call time — no hardcoded candidate context anywhere in code, and the cached system block stays Luke-agnostic.
- **Workday acknowledged as best-effort.** Workday's list endpoint returns title + location + jobId but no description. The adapter scaffold ships with the limitation called out in code and docs: Workday roles get rule-based classification only, and bypass the two-tier funnel entirely. Per-job description hydration via Apify or a headless browser would be a separate add-on.

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
cp config/scoring-caps.example.json     config/scoring-caps.json
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
| Scoring caps      | `config/scoring-caps.json`       | `scoring_caps`       | Per-day volume caps, per-purpose monthly spend caps, Tier-1 → Tier-2 escalation thresholds. Also editable live at `/docs`. |
| Scoring rubric    | `lib/fit/rubric.ts`              | _(in code)_          | Dimension weights, anchors, IC cap, alert threshold. |
| Location filter   | `lib/scan/filter.ts`             | _(in code)_          | `isInScope` defaults to NYC + US-remote. |
| Company logos     | `lib/scan/logos.ts`              | _(in code)_          | Slug → primary domain for favicon-based logos (not sensitive). |

## Costs

Default caps target a $40/month ceiling broken out by purpose. Typical
spend at ~100 new roles/day is closer to $10–15/month; the rest of the
budget is headroom for spikes and per-role Pro/Con summaries.

| Service        | Monthly |
|----------------|---------|
| Vercel Hobby   | $0      |
| Neon free      | $0      |
| Resend free    | $0      |
| Anthropic — Haiku triage  | ~$3–5  (every new role, ~$0.002 cached) |
| Anthropic — Sonnet score  | ~$5–10 (25–35% escalation rate at ~$0.018/call cached) |
| Anthropic — Pro/Con summary | ~$0–2 (on-demand, you click) |
| Anthropic — TOTAL hard cap | **$40 (configurable)** |
| GitHub Actions | $0 (well inside free minutes on public repos) |
| **Total**      | **~$10–15/month typical, $40 hard cap** |

Every cap is editable live at `/docs` without redeploying. Hit the triage
cap and the pipeline falls back to the rule classifier; hit the score
cap and Haiku results are persisted with the level capped at MEDIUM; hit
the total cap and every Claude call stops until the next UTC month.

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
