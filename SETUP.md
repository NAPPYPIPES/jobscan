# SETUP

Step-by-step from clone to live deployment. Plan on 30–45 minutes total.

## 1. Local install

```bash
git clone https://github.com/<you>/pub-ats-radar
cd pub-ats-radar
npm install
```

## 2. Create the cloud accounts

You'll need free-tier accounts at:

- **[Neon](https://neon.tech)** — Postgres. Sign up, create a project,
  copy the **pooled connection string** from "Connection Details".
- **[Resend](https://resend.com)** — daily-digest email. Sign up,
  verify a domain you own (free), then create an API key.
- **[Anthropic](https://console.anthropic.com)** — Claude API. Sign up,
  go to API Keys, create one. Add $5 of credit to start.
- **[Vercel](https://vercel.com)** — hosting. Sign up and connect your
  GitHub account.

## 3. Fill in `.env.local`

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in real values for everything except
`CRON_SECRET` (which you only need for production). For
`AUTH_SECRET`, generate a random string:

```bash
# Mac / Linux:
openssl rand -base64 32

# Windows PowerShell:
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

## 4. Initialize the database

```bash
npx drizzle-kit push
```

This reads `db/schema.ts` and creates every table in your Neon
database. Re-run any time you change the schema.

## 5. Add your resume

```bash
cp docs/resume.example.md docs/resume.md
# Edit docs/resume.md with your real career history.
# See the example file for the recommended structure.

npm run ingest-resume
```

The script parses your resume via Claude Haiku (~$0.01 per run) and
saves the result to the `user_profile` table. Re-run any time you
update the resume.

## 6. Customize the target companies + ingest

Target companies live in the `targets` table at runtime. The
`config/targets.example.json` file is a template; copy it to the
gitignored `config/targets.json`, edit, then push to DB:

```bash
cp config/targets.example.json config/targets.json
$EDITOR config/targets.json
npm run ingest-config -- targets   # or omit "-- targets" to ingest all four configs
```

The `slug` field is whatever appears in the public ATS URL:

- **Greenhouse:** `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs`
- **Ashby:** `https://api.ashbyhq.com/posting-api/job-board/<slug>`
- **Lever:** `https://api.lever.co/v0/postings/<slug>`
- **Workday:** the slug from `<slug>.<host>.myworkdayjobs.com`. Also
  add a row to `config/workday-tenants.json` (with `host` like wd1 /
  wd5 / wd12 and `board` like External_Career_Site), then re-ingest.

Validate every slug returns jobs:

```bash
npm run validate-ats
```

While you're there, edit `lib/scan/logos.ts` to map each slug to the
company's primary domain so logos render in the UI. (Logos live in
code, not DB — they're not sensitive.)

### Production deployment

Vercel uses the same `DATABASE_URL` as your local dev. There is no
separate config sync step:

1. `DATABASE_URL` on Vercel points at your Neon DB.
2. You run `npm run ingest-config` locally (with `DATABASE_URL`
   pointing at the same Neon DB).
3. Next time a Vercel function cold-starts, it reads the updated rows.

No `*_JSON` env vars to maintain. No two-channel sync.

## 6b. (Optional) Tune the classifier keywords

Some classifier vocabulary is personal — phrases that should hit
"Business Value" tier, healthcare hard-exclusion (if applicable),
regex patterns for description-level disqualifiers. Override in
`config/personal-keywords.json`:

```bash
cp config/personal-keywords.example.json config/personal-keywords.json
$EDITOR config/personal-keywords.json
npm run ingest-config -- personal-keywords
```

The default committed example ships with a small healthcare skip
list, a few BV phrases, and empty arrays for the regex fields.
Empty `healthcare_skips` to disable the healthcare hard exclusion
entirely.

## 7. (Optional) Seed company descriptions

The fit-scoring prompt includes a one-sentence description of each
company so Claude knows what the company actually sells. Generate
descriptions for every target:

```bash
# Dry run first — review the output
npm run populate-companies

# Then write to DB
npm run populate-companies -- --write
```

Cost: ~$0.04 for a full pass of 20 companies. Re-run only when you
add or remove targets.

## 8. Customize the manual checklist

Override the example list in `config/manual-companies.example.json`
by copying it to `config/manual-companies.json` (gitignored), then
ingest:

```bash
cp config/manual-companies.example.json config/manual-companies.json
$EDITOR config/manual-companies.json
npm run ingest-config -- manual-companies
```

Six examples ship — Google, Meta, Apple, Microsoft, Amazon AWS,
JPMorgan Chase — each with a pre-filtered careers URL. Edit or
replace to match the custom-ATS companies you want to check daily.

Custom-ATS URL filter parameters drift over time. Click through
each URL after editing to confirm the filter still works.

## 9. (Optional) Tune the scoring rubric

Open `lib/fit/rubric.ts`. The defaults match the original tool's
weights (30% function / 25% seniority / 25% industry / 10% stage /
10% location). Edit the weights to match your priorities — they must
sum to 1.0 or `validateRubric` will fail at module load.

The anchors are written in user-agnostic terms — they reference your
`user_profile` (which the ingest-resume script populated). You
generally don't need to edit them unless you want to change what
each numeric score means.

## 9b. (Optional) Tune the scoring caps

The two-tier AI funnel's cost controls live in `config/scoring-caps.json`
(gitignored) and the `scoring_caps` DB table. Defaults: $40/month total
hard cap, $5 triage / $35 score / $5 summary by purpose, 100 new
jobs/day with a 25/company sub-cap, and Tier-1 → Tier-2 escalation at
score ≥ 7.0 (any confidence), ≥ 5.5 (high confidence), or ≥ 6.5 (medium
confidence).

To customize before first deploy:

```bash
cp config/scoring-caps.example.json config/scoring-caps.json
$EDITOR config/scoring-caps.json
npm run ingest-config -- scoring-caps
```

Or just edit them live from the `/docs` Settings section after you're
running — saves to DB, next scan tick picks up the new values, no
redeploy needed.

## 9c. Upgrading from an earlier internal version

If you're upgrading a DB from before the two-tier funnel landed, apply
the additive migration to add the Tier-1 columns and the `scoring_caps`
table:

```bash
npm run apply-migration-0002
```

Idempotent — safe to re-run. After applying, seed the caps with
`npm run ingest-config -- scoring-caps` (or skip and let the in-code
`FALLBACK_CAPS` defaults take effect).

To re-score the existing backlog under the new rules (estimated
~$3.50 for ~475 rows), see `scripts/migrate-rescore.ts`:

```bash
npm run migrate-rescore -- --dry-run --limit 5   # preview
npm run migrate-rescore -- --limit 5             # test on 5 rows
npm run migrate-rescore                          # full backlog
```

The script has a $5 cost circuit-breaker; pass `--force` to bypass.

## 10. Run locally

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) and sign in with
Google (or your seeded maintainer email). To trigger a scan:

```bash
# In a second terminal:
npm run scan
```

Or hit the API directly:

```bash
curl http://localhost:3000/api/cron/scan
```

You should see `/` populate with matches within ~30 seconds.

## 11. Deploy to Vercel

```bash
# Push your code to GitHub first.
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/pub-ats-radar.git
git push -u origin main
```

Then in the Vercel dashboard:

1. **Import Project** → select your GitHub repo
2. Under **Environment Variables**, add every variable from
   `.env.local` (including a new `CRON_SECRET` you generate now).
   Don't forget `SITE_URL` set to whatever Vercel gave you, e.g.
   `https://pub-ats-radar.vercel.app`
3. **Deploy**

After the first deploy, hit `https://<your-url>/api/cron/scan` once
manually (it'll fail auth without the bearer token; that's expected —
the failure confirms the route exists) to confirm routing works.

## 12. Wire up the GitHub Actions cron

In your GitHub repo, go to **Settings → Secrets and variables →
Actions** and add two repository secrets:

- `SITE_URL` — your deployed Vercel URL (no trailing slash)
- `CRON_SECRET` — the same value you set in Vercel env

The workflow at `.github/workflows/cron.yml` will then:

- Hourly: hit `/api/cron/scan` then `/api/cron/score`
- Daily at 00:15 UTC: hit `/api/cron/digest`

Edit the cron schedules in that file to taste. Vercel Hobby allows
unlimited GitHub Actions usage on the free tier as long as the repo
is public.

## 13. Confirm the daily digest

After the first 24h of scanning, the daily-digest workflow will fire
and send you an email summarizing new BV/HIGH roles. If you don't see
it, check the workflow run logs in GitHub Actions, and look at the
Resend dashboard for delivery status.

## Done

You should now be receiving:

- A daily email of new BV/HIGH roles (if any were found)
- A live `/` page showing all open matches from the last 24h
- A `/manual` checklist for your custom-ATS companies
- A `/docs` page showing your month-to-date Anthropic spend

Anything else, open an issue.
