# Jane Doe — Career History

This is the template for the long-form resume that `scripts/ingest-resume.ts`
parses into the `user_profile` table. Copy this file to `docs/resume.md`,
replace everything below with your own content, and run `npm run ingest-resume`.

The file is gitignored. Only `resume.example.md` (this file) is committed.

The parser cares about three things:

1. **Concrete details** — companies, dates, dollar amounts, product categories,
   metrics. The more specific you are, the better the fit scoring will be.
2. **A "Target Roles" section** — explicit role titles you're looking for.
3. **A "Hard Exclusions" section** — verticals, role types, or geographies
   you do NOT want.

You can write the rest of the resume however you like — Markdown formatting
is recommended but not required. Section headings are helpful but not parsed
literally. The parser reads the whole document and extracts structured fields.

---

## Current Role

**VP of Sales** at **Acme Corp**, 2023 — present

- Built and led the enterprise sales team from 3 to 14 reps; revenue grew
  from $4M to $22M ARR over 18 months.
- Closed $3.2M ARR personally in the first 12 months, including the
  largest deal in company history ($1.4M).
- Owned the GTM motion redesign: shifted from inbound-led SMB sales to a
  named-account ABM strategy targeting Fortune 1000 buyers.

## Previous Roles

**Director of Sales** at **Beta Industries**, 2020 — 2023
- Promoted from Senior AE; managed a team of 6 enterprise AEs.
- Hit 130% of $8M quota in 2022.

**Enterprise Account Executive** at **Gamma Software**, 2017 — 2020
- $2.5M quota; carried regional book across North America insurance vertical.
- Closed $1.8M six-figure deal with a top-5 US insurer.

**Senior Account Executive** at **Delta Systems**, 2014 — 2017
- First 5 years in tech sales; learned the trade selling middleware to
  Fortune 500 IT buyers.

## Target Roles

I'm looking for senior leadership roles where I can shape GTM strategy
and build/grow a team. Specifically:

- VP Sales at an AI-native or enterprise SaaS company (Series C through public)
- Head of Revenue or CRO at a Series B/C startup with $5–20M ARR
- VP GTM at any stage where the founder is the current revenue owner
- Business Value Consulting / Value Engineering director-level roles at
  large enterprise software vendors (Salesforce, Datadog, etc.)

## Hard Exclusions

- Healthcare-focused roles (no medical / pharma / biotech background)
- IC-only roles below Director level — looking for management leverage
- Roles requiring relocation outside the NYC metro area
- Pure channel / partnerships roles (don't have program-management experience)

## Geographic Constraints

- NYC metro area (Manhattan / Brooklyn / Westchester / Jersey City)
- Remote-US roles where company HQ is in NYC, SF, or Boston
- Will not relocate

## Industries / Domains

Years of experience by domain:

- Enterprise SaaS — 8 years (Beta, Acme)
- AI / AI-native software — 2 years (current role at Acme)
- Insurance vertical — 3 years (Gamma)
- Middleware / developer infra — 3 years (Delta)
- Financial services — 0 years (no direct experience; comfortable selling
  into FS buyers but not a domain expert)

## Notable Quantitative Achievements

- $22M ARR scale (Acme, current)
- 130% quota attainment (Beta, 2022)
- $1.4M largest single deal (Acme)
- 14-rep team built from scratch (Acme)

---

The structured sections above ("Target Roles", "Hard Exclusions", etc.)
are recommended because the parser explicitly looks for them. Everything
else is freeform — write whatever helps the parser understand your
seniority, industries, and trajectory.
