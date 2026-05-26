import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, companies, matches, userMatches } from "@/db/schema";
import { ALL_ATSES, LEVEL_ORDER, type Level, type Sector } from "@/lib/scan/types";
import { sectorForSlug } from "@/db/targets";
import { extractScoringText, fetchDescription } from "./fetch-description";
import { DEFAULT_RUBRIC, formatRubricForPrompt, type ScoringRubric } from "./rubric";
import { getUserProfile, getRawResume } from "@/db/profile";
import { checkSpend } from "./spendCaps";
// Tier1Result type stays imported — still used by the pending-BV-
// verification path (rows that were tier-1-scored under the old 2-tier
// funnel) and by scoreFitWithClaude's optional tier1 context block.
// The triage/escalation helpers themselves are no longer called after
// the 2026-05-25 all-Sonnet migration (see scoreUnscoredEligibleForUser
// header), but the lib/fit/triage.ts and lib/fit/escalation.ts modules
// remain on disk for scripts/migrate-rescore.ts.
import { type Tier1Result } from "./escalation";

// Claude Sonnet 4.6 — Tier-2 deep-scorer. Sees the full JD, the full
// resume, and Haiku's Tier-1 take. Produces dimension scores + a level
// recommendation. The level_recommendation is authoritative (overrides
// the old levelFromFit score-banded mapping).
const MODEL = "claude-sonnet-4-6";

// Public Anthropic Sonnet 4.6 pricing as of 2026-05. Update if rates
// move — these multiply token counts into the cost ledger.
const INPUT_PER_MTOK = 3.0;
const OUTPUT_PER_MTOK = 15.0;
const CACHE_WRITE_PER_MTOK = 3.75;       // 125% of base
const CACHE_READ_PER_MTOK = 0.30;        // 10% of base

export type CapStatus = {
  hardReached: boolean;
  softReached: boolean;
  spend: number;
  label: string;
};
export type CapCheckFn = () => Promise<CapStatus>;

// Cap check is per-user — each user's apportioned budget comes from
// user_extras.monthly_cap_usd via spendCaps.ts. Hard cap = score-
// purpose cap or total cap (whichever hits first). Soft warn at 80%
// of score cap so logs surface the approach.
//
// Factory takes the userId at construction time; the returned closure
// is the CapCheckFn shape scoreFitWithClaude wants.
export function makeUserCapCheck(userId: string): CapCheckFn {
  return async () => {
    const status = await checkSpend(userId, "score");
    const hardReached = status.capReached || status.totalCapReached;
    const softReached = status.spent >= status.cap * 0.8;
    const label = status.totalCapReached
      ? `total $${status.totalCap.toFixed(0)}`
      : `score $${status.cap.toFixed(0)}`;
    return {
      hardReached,
      softReached,
      spend: status.totalCapReached ? status.totalSpent : status.spent,
      label,
    };
  };
}

export type FitFlag =
  | "none"
  | "relocation_required"
  | "level_mismatch"
  | "ic_role"
  | "bv_role"
  | "partnerships_specialist";

export type FitScore = {
  dimensions: {
    function: number;
    seniority: number;
    industry: number;
    stage: number;
    location: number;
  };
  score: number;
  summary: string;
  flag: FitFlag;
  // Sonnet's authoritative level assignment — overrides the score-banded
  // levelFromFit mapping. Set per the BV-vs-HIGH rules in the system
  // prompt: BV reserved for explicit value-consulting title + Director
  // seniority; HIGH for strong non-BV fits; MEDIUM for adjacent; LOW
  // for stretches or hard exclusions.
  levelRecommendation: Level;
  // Required when levelRecommendation = "BV": Sonnet's quote of the
  // title pattern and seniority signal that justified BV. Empty string
  // otherwise. Logged for audit so every BV assignment is traceable.
  bvReasoning: string;
};

export type ScoreResult =
  | {
      ok: true;
      fit: FitScore;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    }
  | {
      ok: false;
      reason: "cap_reached" | "missing_key" | "api_error" | "parse_error" | "already_scored" | "no_profile";
      error?: unknown;
    };

// Single-row lookup of a company description by slug. Returns null
// when the company hasn't been seeded yet (graceful degradation —
// the prompt notes the description is "(unknown)" so Claude can still
// produce a reasonable score from title + location alone).
export async function getCompanyDescription(slug: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ description: companies.description })
    .from(companies)
    .where(eq(companies.slug, slug))
    .limit(1);
  return rows[0]?.description ?? null;
}

// Sum of api_usage.cost_usd for the current calendar month (UTC),
// scoped to a single user. Phase 5: caller passes their viewerUserId
// so the spend display in /docs is per-viewer, and the cap pre-checks
// in /api/matches/[id]/summarize gate on the right user's budget.
export async function getCurrentMonthSpend(userId: string): Promise<number> {
  const db = getDb();
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text` })
    .from(apiUsage)
    .where(and(eq(apiUsage.userId, userId), gte(apiUsage.calledAt, start)));
  return parseFloat(rows[0]?.total ?? "0");
}

// Build the Sonnet system prompt as a single cache-flagged content block.
// Resume + BV definition + rubric + level rules + output schema are all
// stable across calls, so cache_control: ephemeral keeps marginal input
// cost at ~10% of base rate after the first call in a 5-min window.
//
// Prefer the raw resume markdown over the parsed user_profile summary —
// the parsed summary loses signal (Salesforce BVS detail, specific
// company names, accolades) that Sonnet needs for accurate BV detection.
// Falls back to the parsed summary if raw resume is missing.
async function buildSystemBlocks(
  userId: string,
  rubric: ScoringRubric,
): Promise<Anthropic.Messages.TextBlockParam[]> {
  // Per-user resume read. Maintainer's resume comes from
  // `npm run ingest-resume`; new users' resumes from the onboarding
  // wizard. Both routes write to user_profile keyed on user_id.
  const raw = await getRawResume(userId);
  const profile = await getUserProfile(userId);

  const profileBlock = raw
    ? raw
    : profile
      ? [
          `CANDIDATE PROFILE (parsed summary — raw resume not loaded):`,
          profile.parsedSummary,
          ``,
          `Years of experience: ${profile.yearsExperience ?? "(not stated)"}`,
          `Seniority level: ${profile.seniorityLevel ?? "(not stated)"}`,
          `Industries: ${(profile.industries ?? []).join(", ") || "(none listed)"}`,
          `Functions: ${(profile.functions ?? []).join(", ") || "(none listed)"}`,
          `Target roles: ${(profile.targetRoles ?? []).join(", ") || "(none listed)"}`,
          `Hard exclusions: ${(profile.hardExclusions ?? []).join(", ") || "(none listed)"}`,
        ].join("\n")
      : `CANDIDATE PROFILE: (No profile loaded — score industry/seniority neutrally from title + JD only.)`;

  const exclusions = (rubric.hardExclusions ?? []).join(", ") || "none";
  const rubricText = formatRubricForPrompt(rubric);

  const text = `You are the Tier-2 deep-scorer for a personal job-fit pipeline. A cheaper Tier-1 model has already triaged this role and flagged it as worth a careful look. Your job is to produce the authoritative fit assessment.

You return strictly valid JSON, no other text, no markdown fences.

================================================================
CANDIDATE PROFILE
================================================================
${profileBlock}

================================================================
WHAT "BV" MEANS FOR THIS CANDIDATE — READ CAREFULLY
================================================================
The candidate's BV (Business Value) experience is specifically 8 years at Salesforce running the Business Value Services practice for the Financial Services vertical. They built ROI frameworks, business cases, and executive narratives for F500 enterprise deals; led a team of value engineers and AE coaches; co-authored industry whitepapers; and were the primary value consulting voice for hundreds of bank and credit union pursuits.

BV scoring is RESERVED for roles whose TITLE contains explicit business-value function words AND whose SENIORITY is Director-and-above or equivalent staff-IC. Examples that qualify:
  - "Business Value Engineer" at Databricks
  - "Senior Value Consultant" at Anthropic
  - "Head of Business Value Services" at Snowflake
  - "Value Engineer, AI Success" at OpenAI
  - "Director of Value Engineering" at MongoDB
  - "Principal Value Advisor" at any enterprise SaaS company

Roles that are STRONG FITS but NOT BV — these must be HIGH, never BV:
  - "VP GTM" at Glean
  - "Director of Enterprise Sales" at Mercury
  - "Head of Revenue" at Decagon
  - "VP Strategic Sales" at Notion
  - "Head of Sales" at any AI-native company
  - Any Sales Engineering / Solutions Consulting role, even at Director level
  - Any RevOps / GTM Strategy role, even at VP level
  - Any Customer Success role unless the title explicitly says "Value"
  - Any AE / Account Executive role at any level
  - Any Partnerships / Alliances role

A 9.0 fit that isn't explicit value work should be HIGH. The seniority bar matters too — a "Value Consultant" at Manager level is NOT BV.

================================================================
SCORING RUBRIC — five dimensions, 0–10 each
================================================================
${rubricText}

You assign the dimension scores. The consumer computes the weighted average and applies the IC cap deterministically — you do not need to math the final score. You DO assign level_recommendation directly, using the rules below.

================================================================
HARD EXCLUSIONS
================================================================
Flags that force a 0.0 overall score (set the matching flag and also drop the industry/location dimension to 0):
  ${exclusions}

================================================================
INTUITION FIRST — TRUST THE RESUME OVER THE TITLE
================================================================
Lean on intuition about the candidate's career arc, NOT on title-pattern
matching. The resume describes 15 years across Salesforce Business Value
Services, vendor-side GTM leadership selling INTO financial services and
enterprise SaaS, ROI/value frameworks, and exec relationships at F500.
They are not a title-shopper — they care about role substance, comp
band, runway to senior leadership, and the type of work day-to-day.

VENDOR vs BANKER — critical FinServ distinction
The candidate has spent their career on the VENDOR side selling TO
banks / asset managers / insurers / exchanges. They have NEVER worked
AT a bank doing banker work. Score INSIDE-the-bank roles down
accordingly:

  ROLES THAT ARE NOT A FIT (default LOW even at VP/MD/Director level):
    - Investment Banking / IB Associate / IB VP / IB Director
    - Investment Counselor / Wealth Advisor / Private Banker
    - FX Salesperson / FX Trader / Rates Salesperson / Sales Trader
    - Commercial Banker / Mortgage Lender / Cash Management Sales
    - Corporate Banker / Treasury Solutions
    - Asset Manager Portfolio Manager / Buy-side Analyst
    - Investment Product Specialist / Investment Product Marketer
    - Hedge Fund / PE Investor / Deal Team
    - Underwriter / Credit Analyst / Risk-specific roles
    - Wealth Communications / Wealth Operations / Wealth Strategy
    - Trade Structuring / Securities Lending / Prime Brokerage
    - Capital Markets / DCM / ECM / Syndicate / Levered Finance
  These titles often carry "VP" or "MD" at banks (especially Citi, JPM,
  BoA, GS, MS) but represent IC banker work, NOT GTM leadership. The
  candidate categorically does not have this background and will not
  pursue these. Score them LOW. Override only when the JD's required
  skills are an unambiguous match for vendor-side ROI/value/exec-
  narrative work (rare).

  ROLES THAT ARE A FIT inside a FinServ-branded employer:
    - Vendor-side GTM at Mastercard / Visa / S&P Global / Nasdaq / LSEG
      / Broadridge / iCapital / Arcesium / Capital One Software / etc.
      — these companies SELL data, payments, platforms, or services
      to other FinServ firms; the GTM roles there map directly to the
      candidate's vendor experience.
    - "Sales / Business Development / Strategic Sales / Enterprise Sales"
      at any FinServ vendor where the buyer is institutional.
    - "Director / VP / Head of [GTM / Sales / Revenue / Value /
      Strategy / Operations / Transformation]" at a FinServ VENDOR.
    - "Partnerships / Alliances" when the partner ecosystem is
      vendor-to-vendor (e.g. payments rails, data partnerships).
  These score normally per the rubric — vendor-side GTM at a FinServ
  brand is exactly the candidate's lane.

  HEURISTIC: if the role lives inside a P&L of a bank's revenue line
  (trading, IB, wealth, lending, AM), it's banker work → LOW. If the
  role lives inside the vendor's sales/GTM/value org or a vendor-style
  function at a FinServ-branded company, it's vendor work → score
  normally.

Default lens for every score and the level call:
  1. What does this role actually DO day-to-day? Read the
     Responsibilities + Required Skills sections of the JD.
  2. Does the candidate's resume show they've done that work — or work
     that obviously transfers — and at the same scale (enterprise vs
     mid-market, F500 vs SMB)?
  3. Where would this role sit on their career arc — lateral, step-up,
     or step-down? Step-up roles in the right function score high. Step-
     down roles (Manager/IC) score low even with a great brand.
  4. Does the listed comp/seniority fit the candidate's stated band?
       - OTE $250-400k (base + bonus) OR
       - $200k+ base minimum, AND
       - 8-15+ years experience asked (peak 10-12).
     Roles materially below the band score down on seniority even when
     the function fits. Roles materially above (CRO succession, $500k+
     base, 20+ YOE explicitly stated) score down on seniority too.
  5. Would a 15-year GTM leader with the candidate's resume actively
     WANT this role? If you'd hesitate to recommend it to them, that's
     a MEDIUM or LOW.

Title-pattern matching is a TIE-BREAKER, not the primary signal. A
"Director of Strategy" with no GTM token in the title can be HIGH if
the JD's responsibilities map to the resume's BV / commercial / exec
narrative work. A "VP, Sales" can be MEDIUM if the JD reads like the
role is mid-market SMB and the resume is enterprise/strategic. Titles
lie; responsibilities + required skills + comp don't.

================================================================
ALIGNMENT GUIDANCE — supporting detail
================================================================
Your authority comes from comparing the JD's required skills and
responsibilities to the candidate's actual resume work history and Skills
section — NOT from title-pattern matching alone. A "Director, Sales"
title can be a strong fit or a weak fit depending on whether the JD's
required skills appear in the resume.

Use this lens for both function scoring AND level_recommendation:

  - JD's required skills + responsibilities show direct overlap with
    demonstrated work on the resume → score function high, lean HIGH.
  - Adjacent skills, transferable but not exact → score function 6-8,
    lean MEDIUM.
  - Required skills mostly absent from the resume → score function low,
    lean LOW even if the title looks adjacent.

Title matters but is secondary. The "ic_role" and
"partnerships_specialist" flags below are SOFT guidance — they nudge
toward MEDIUM by default, but you have authority to override when the
resume↔JD alignment is unusually strong (or unusually weak).

================================================================
FLAG RULES — set exactly one
================================================================
- "relocation_required": role is NOT in NYC, NYC metro (Westchester, Long Island, Northern NJ commute corridor, southern CT), OR US-remote. Set this whenever:
    (a) The location field names a non-NYC US city (SF, LA, Austin, Boston, Chicago, Seattle, Denver, Atlanta, Dallas, Miami, DC-only, Portland, etc.) without a remote / NYC-hybrid option, OR
    (b) The role is anchored to a non-Northeast US region (Account Executive - West, RVP Pacific Northwest, Sales Director - Bay Area, Account Manager LATAM, Strategic Sales EMEA, etc.) — even if the location field looks generous, the title carries the constraint, OR
    (c) The role requires international relocation (UK, Germany, Singapore, India, EMEA broadly, APAC, etc.).
   HARD: forces level_recommendation = LOW and composite = 0.
- "level_mismatch": role is below the candidate's target seniority. Set this WHENEVER the title contains any of:
    - "Analyst" at any level (Senior Analyst, Principal Analyst, Strategic Analyst, GTM Analyst, Sales Strategy Analyst, etc.) — even Principal Analyst is IC analytical work, NOT a leadership role for this candidate. The "Senior" prefix on an IC analytical title does NOT constitute a leadership modifier; a leadership modifier requires explicit team-management language or a Manager / Director / VP / Head / Principal-of-a-function suffix (not "Principal Analyst", which is still IC). A Sales Strategy Analyst at Salesforce or any tier-1 employer still trips this flag — brand prestige does not override.
    - "Representative" / "Rep" (Sales Rep, Account Rep, Partner Development Representative, etc.).
    - "Coordinator", "Associate" (any level), "Junior" / "Jr.", "Specialist" without a Director/VP/Head leadership modifier, "Intern", "Fellow", "Apprentice", "Entry-level", "Mid-level IC".
    - YOE requirement of 0-3 years.
   These are TITLE-LEVEL hard rules — don't soften them based on a strong JD; the candidate categorically would not pursue these. HARD: forces level_recommendation = LOW.
- "ic_role": individual-contributor sales role (AE, Sales Rep) with no team-management scope. SOFT default = MEDIUM. Use your judgment to elevate to HIGH when ALL of these hold:
    (a) the JD's required skills (enterprise sales motion, multi-stakeholder deals, ROI/value-based selling, executive-level customer relationships) line up explicitly with the candidate's resume work history, AND
    (b) the company is a tier-1 target (AI-native, top fintech, enterprise SaaS leader, or financial-services where the candidate has direct background), AND
    (c) the deal scope is enterprise / strategic (not mid-market / SMB).
  Demote to LOW when the role is clearly mid-market/SMB AE work or the JD's required skills don't appear in the resume. Consumer still applies the numerical IC score cap automatically — that's separate from the level call.
- "bv_role": role's primary function is Business Value Consulting / Value Engineering per the title patterns above AND seniority is Director-and-above or staff-IC. Set whenever level_recommendation = "BV". HARD: forces level_recommendation = BV.
- "partnerships_specialist": title contains "Partnerships" or "Alliances". SOFT default = MEDIUM. Elevate to HIGH when ALL of these hold:
    (a) strategic alliances scope at director+ with team-management responsibility, AND
    (b) the candidate's resume shows directly transferable partner / channel / GSI experience, AND
    (c) the alliance is revenue-driving (not pure implementation / program management).
  Demote to LOW for purely ops / implementation / program-management partner roles, OR when the alliance scope is far from the candidate's demonstrated experience.
- "none": none of the above.

================================================================
LEVEL_RECOMMENDATION — your authoritative level assignment
================================================================
This overrides the score→level mapping. Use these explicit rules:

BV — assign ONLY if:
  (a) the title contains explicit business-value function words (Business Value / Value Consulting / Value Engineering / Value Realization / Value Advisory / Value Architecture / Value Services), AND
  (b) seniority is Director-and-above OR staff-IC equivalent (Staff / Principal / Distinguished / Lead / Senior Principal). A plain "Senior" prefix (e.g. "Senior Value Engineer", "Senior Value Consultant") does NOT clear the staff-IC bar — those roles are HIGH, not BV.
  Do NOT inflate other strong-fit roles to BV — they are HIGH instead. When in doubt about title fit for BV, assign HIGH. BV is rare by design.

HIGH — strong alignment across function + seniority + industry, AND the JD's required skills clearly map to the candidate's resume. Use HIGH whenever:
  - Function + seniority + industry dimensions are all 8+, AND
  - The composite weighted score is 8.5+ with no hard exclusion flag, AND
  - You'd actively recommend the candidate pursue this role.
  Examples:
  - VP GTM / VP Sales / VP Revenue at an AI-native or enterprise SaaS company
  - Head of Strategic Sales in financial services
  - Director of Enterprise Sales at Series B-D where the JD names enterprise sales motion, ROI quantification, and exec-level customer relationships (all present in the resume)
  - "Value Consultant" at Manager level (matches function but missing seniority for BV)
  - An IC AE role at a tier-1 AI company where the JD's required skills match the resume's enterprise sales motion (per the "ic_role" elevation rule above)
  When the composite is 8.5+ with flag = "none", default to HIGH unless there's a specific dimension misalignment you can name that justifies MEDIUM.

MEDIUM — meaningful fit on most dimensions but with at least one clear gap, OR a flagged role where the resume↔JD alignment is solid but not strong enough to elevate:
  - Right function, wrong stage
  - Right seniority, adjacent function (CS / RevOps / Sales Strategy when target is direct sales leadership)
  - Right function + seniority, weak industry fit
  - ic_role / partnerships_specialist where alignment is solid but doesn't clear the HIGH bar above

LOW — adjacent or stretched roles not worth alerting on, OR hard exclusions, OR the JD's required skills don't overlap meaningfully with the resume even though the title looks adjacent.

Internal consistency required:
  - flag = "bv_role"             → level_recommendation = "BV"
  - flag = "level_mismatch"      → level_recommendation = "LOW"
  - flag = "relocation_required" → level_recommendation = "LOW"
  - flag = "ic_role"             → MEDIUM default; HIGH / LOW allowed per the soft rule above. Justify any non-MEDIUM call in the summary.
  - flag = "partnerships_specialist" → MEDIUM default; HIGH / LOW allowed per the soft rule above. Justify any non-MEDIUM call in the summary.

================================================================
BV DIMENSION CALIBRATION — OVERRIDE FOR BV-PATTERN ROLES
================================================================
When you assign level_recommendation = BV, the default rubric anchors
under-score the role. Apply these BV-specific overrides:

  function:  ALWAYS 10. By definition, BV titles (Value Engineer /
             Value Consultant / Business Value / Value Realization /
             Value Advisory / Value Architecture / Value Services)
             ARE the candidate's target role — exact match.

  seniority: Use this BV-specific scale, NOT the generic rubric scale.
             The candidate considers staff-IC at top AI/SaaS companies
             to be at-target seniority — those companies use IC-track
             titles (Staff, Principal, Distinguished, Lead) for roles
             that other companies would title Director. Score
             accordingly:
                 10  Director / Senior Director / VP / Head of BV
                     practice at any company,
                     OR a STAFF-IC-tier BV title at a top-tier AI,
                     SaaS, or fintech company. Staff-IC tier requires
                     one of: "Staff", "Principal", "Distinguished",
                     "Lead", "Senior Principal" prefix (e.g. "Staff
                     Value Engineer", "Principal Value Consultant",
                     "Distinguished Value Architect", "Lead Value
                     Engineer"). Top-tier list: OpenAI, Anthropic,
                     Databricks, Glean, Cursor, Sierra, Decagon,
                     Stripe, MongoDB, Snowflake, Cohere, Mistral,
                     Twilio, Plaid, Brex, etc.
                     IMPORTANT: a plain "Senior" prefix is NOT
                     staff-IC. "Senior Value Engineer" / "Senior
                     Value Consultant" map to 9, not 10 — the
                     candidate is past the senior-IC band and targets
                     either Director+ or true staff-track titles.
                  9  Plain "Value Engineer" / "Senior Value Engineer"
                     / "Value Consultant" / "Senior Value Consultant"
                     at any top-tier company (one band below the
                     candidate's target — IC level with no staff-track
                     signal), OR "Value Consultant" / "Value Engineer"
                     at companies further from the top-tier AI/SaaS
                     cluster, OR Manager-of-Value-Consultants at any
                     company. NOTE: when seniority for a BV-titled
                     role lands at 9 because of the Senior-only IC
                     pattern above, prefer level_recommendation = HIGH
                     over BV unless the role has other strong staff-IC
                     signals in the JD (scope, headcount under, deal
                     size). BV is reserved for at-target seniority.
                  8  Senior Manager of a small Value team.
                  7  Manager-level Value Consultant (under target —
                     usually downgrade to HIGH not BV).
             Do NOT use the generic "VP/SVP = 10, Director = 7" anchor
             from the rubric — that scale assumes a non-BV target.

  industry:  AI-native (OpenAI, Anthropic, Databricks, Cohere, Glean,
             Cursor, Sierra) and enterprise SaaS / fintech BV roles
             score 9-10. Only downgrade for genuinely off-thesis
             companies (consumer B2C, crypto-only).

  stage:     Use the default rubric anchors — BV doesn't change stage
             fit math.

  location:  Use the default rubric anchors — BV doesn't change
             geography math.

The OVERALL composite (weighted-average) score for confirmed BV matches
must land 9.5–9.9 by default. The candidate considers a BV role at any
top-fit company to be "basically the same job" as their prior Salesforce
position — so the scoring should reflect that. Only downgrade below 9.5
if there's a clear soft dimension (Manager-level not staff-IC, off-thesis
industry, requires relocation).

Reserve 10.0 ONLY for the literal pre-employer: the actual title
"Senior Director, Business Value Services, Financial Services" at
Salesforce specifically. Every other BV role at any other company caps
at 9.9, because by definition it isn't the literal prior job.

Calibration examples (target overall scores):
  - "Senior Director, BVS, FinServ" at Salesforce (literal prior job) → 10.0
  - "Staff Value Engineer, AI Success - NYC" at OpenAI                → 9.9 (basically the same job; AI-native; NYC; staff-IC tier)
  - "Principal Value Consultant, Financial Services" at Databricks    → 9.9 (same vertical + BV title at top AI infra co; staff-IC)
  - "Business Value Consultant" at Glean (no staff prefix)            → assign HIGH at ~8.6 — title matches BV but seniority lands at 9 without a staff/principal/lead prefix; HIGH not BV per the seniority rule above
  - "Director, Business Value Consulting" at Glean                    → 9.7 (BV title + Director seniority)
  - "Senior Value Engineer" at Twilio                                 → assign HIGH at ~8.7 (NOT BV) — "Senior" alone is below the staff-IC bar; the candidate is past senior-IC tier
  - "Staff Value Engineer" at Twilio                                  → 9.4 (BV-eligible; true staff-IC; AI-adjacent industry softness)
  - "Director of Value Engineering" at MongoDB                        → 9.7
  - "Value Consultant" at Manager level at any company                → NOT BV → assign HIGH

Crucial: under the BV-specific seniority scale, true STAFF-IC tier
(Staff / Principal / Distinguished / Lead / Senior Principal prefix) at
a top AI or enterprise SaaS company maps to seniority = 10. That's the
candidate's at-target seniority band for IC-track BV practitioner roles
— equivalent to Director seniority on the management track. Plain
"Senior Value Engineer" / "Senior Value Consultant" without a staff-
track prefix maps to seniority = 9 and should typically be assigned
level_recommendation = HIGH (not BV), because the candidate is past
senior-IC tier. The generic rubric's "VP/SVP = 10, Director = 7" anchor
does not apply here.

================================================================
OUTPUT
================================================================
Return this JSON exactly. No other text. No markdown fences.

{
  "dimensions": {
    "function": <0.0–10.0>,
    "seniority": <0.0–10.0>,
    "industry": <0.0–10.0>,
    "stage": <0.0–10.0>,
    "location": <0.0–10.0>
  },
  "summary": "<one sentence, max 30 words>",
  "flag": "none" | "relocation_required" | "level_mismatch" | "ic_role" | "bv_role" | "partnerships_specialist",
  "level_recommendation": "BV" | "HIGH" | "MEDIUM" | "LOW",
  "bv_reasoning": "<one short sentence — REQUIRED if level_recommendation = BV; empty string otherwise>"
}`;

  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

// One Claude call: prompt → JSON → parse → return. Pre-call cap check
// and idempotency guard live here so the caller stays simple. Caller
// is responsible for persisting both the matches.fit_* fields and the
// api_usage row when ok:true.
export async function scoreFitWithClaude(args: {
  userId: string;
  matchId: string;
  title: string;
  company: string;
  companySlug: string;
  location: string;
  description: string;
  sector: Sector;
  // Tier-1 result, when this role was escalated from Haiku. Sonnet's
  // user message includes Tier-1's quick_take so Sonnet has Haiku's
  // read as context. Crucially the prompt also instructs Sonnet to
  // trust the full JD over Tier-1's snippet-based read — Sonnet is the
  // authority. Optional for backwards compat with the legacy direct-
  // score path (e.g. the migration script's Tier-1-less rescore).
  tier1?: Tier1Result;
  // Calibration / re-score path: bypass the fit_score IS NULL
  // idempotency guard so a previously-scored row can be rescored
  // against an updated rubric. Default false (production path never
  // re-pays).
  force?: boolean;
  // Pluggable cap check — defaults to the current user's monthly cap.
  capCheck?: CapCheckFn;
  // Pluggable rubric — defaults to DEFAULT_RUBRIC.
  rubric?: ScoringRubric;
}): Promise<ScoreResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "missing_key" };
  }

  // Idempotency: if a prior scoring pass already scored this row FOR
  // THIS USER, don't pay again on a retry. fit_score IS NOT NULL on
  // the user_matches row means we have a result for them.
  if (!args.force) {
    const db = getDb();
    const existing = await db
      .select({ fitScore: userMatches.fitScore })
      .from(userMatches)
      .where(
        and(
          eq(userMatches.userId, args.userId),
          eq(userMatches.matchId, args.matchId),
        ),
      )
      .limit(1);
    if (existing[0]?.fitScore != null) {
      return { ok: false, reason: "already_scored" };
    }
  }

  const cap = await (args.capCheck ?? makeUserCapCheck(args.userId))();
  if (cap.hardReached) {
    console.error(
      `[fit] ${cap.label} cap reached ($${cap.spend.toFixed(2)}). Skipping.`,
    );
    return { ok: false, reason: "cap_reached" };
  }
  if (cap.softReached) {
    console.warn(
      `[fit] approaching ${cap.label} cap ($${cap.spend.toFixed(2)}).`,
    );
  }

  const client = new Anthropic({ apiKey });
  const rubric = args.rubric ?? DEFAULT_RUBRIC;

  // Description trimmed to 3500 chars (~900 tokens) per the redesign —
  // shorter than the prior 6000 char limit because the long tail of JD
  // boilerplate isn't useful, and a tighter cap reduces variable input
  // tokens (cached system block already dominates). extractScoringText
  // is called by the caller before reaching here.
  const desc = args.description.length > 3500
    ? args.description.slice(0, 3500) + "…"
    : args.description;

  const companyDescription = await getCompanyDescription(args.companySlug);
  const systemBlocks = await buildSystemBlocks(args.userId, rubric);

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: buildUserMessage({
            title: args.title,
            company: args.company,
            companyDescription,
            location: args.location,
            description: desc,
            tier1: args.tier1,
          }),
        },
      ],
    });

    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;

    const costUsd =
      (tokensIn / 1_000_000) * INPUT_PER_MTOK +
      (cacheReadTokens / 1_000_000) * CACHE_READ_PER_MTOK +
      (cacheWriteTokens / 1_000_000) * CACHE_WRITE_PER_MTOK +
      (tokensOut / 1_000_000) * OUTPUT_PER_MTOK;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const fit = parseFitJson(text, rubric);
    if (!fit) {
      console.error(`[fit] parse failed for match ${args.matchId}: ${text.slice(0, 200)}`);
      return { ok: false, reason: "parse_error" };
    }

    return {
      ok: true,
      fit,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
    };
  } catch (err) {
    console.error(`[fit] API error for match ${args.matchId}:`, err);
    return { ok: false, reason: "api_error", error: err };
  }
}

function buildUserMessage(args: {
  title: string;
  company: string;
  companyDescription: string | null;
  location: string;
  description: string;
  tier1?: Tier1Result;
}): string {
  // Tier-1 context block — included only when this role was escalated.
  // The migration script and the legacy direct-score path call without
  // tier1 (no Haiku run); Sonnet just scores from the JD alone.
  const tier1Block = args.tier1
    ? [
        ``,
        `Tier-1 triage said:`,
        `  score=${args.tier1.tier1_score.toFixed(1)}, confidence=${args.tier1.confidence}, potential_bv=${args.tier1.is_potential_bv}`,
        `  "${args.tier1.quick_take}"`,
        ``,
        `(Tier-1 only saw the first 600 chars and may be wrong about seniority. Trust the full JD below over Tier-1's read.)`,
      ].join("\n")
    : "";

  return `Role to score:
Title: ${args.title}
Company: ${args.company}
Company description: ${args.companyDescription ?? "(unknown — score from title and JD only)"}
Location: ${args.location}
${tier1Block}

Description (first 3500 chars of extracted scoring text):
${args.description}`;
}

// Compute the weighted-average fit score from the 5 dimensions and
// apply the IC cap deterministically. Done in code (not in the model)
// because earlier models were observed snapping IC scores to the cap
// even when the raw average was below it. Keeps cap policy in one
// place too.
function computeScore(
  dims: FitScore["dimensions"],
  flag: FitFlag,
  rubric: ScoringRubric,
): number {
  const w = {
    function: rubric.dimensions.function.weight,
    seniority: rubric.dimensions.seniority.weight,
    industry: rubric.dimensions.industry.weight,
    stage: rubric.dimensions.stage.weight,
    location: rubric.dimensions.location.weight,
  };
  const raw =
    dims.function * w.function +
    dims.seniority * w.seniority +
    dims.industry * w.industry +
    dims.stage * w.stage +
    dims.location * w.location;
  const rounded = Math.round(raw * 10) / 10;
  if (rubric.hardExclusions.includes(flag)) return 0.0;
  if (flag === "ic_role" && rounded > rubric.icRoleCap) return rubric.icRoleCap;
  return rounded;
}

// Parse Claude's JSON response. Tolerates the model wrapping the JSON
// in a ```json fence even though the system prompt asks for raw JSON.
// Validates the new level_recommendation + bv_reasoning fields and
// enforces flag/level internal consistency (e.g. bv_role flag forces
// level=BV). Returns null on any shape mismatch.
function parseFitJson(text: string, rubric: ScoringRubric): FitScore | null {
  let body = text.trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const d = p.dimensions as Record<string, unknown> | undefined;
  if (!d) return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const f = num(d.function);
  const sen = num(d.seniority);
  const ind = num(d.industry);
  const sta = num(d.stage);
  const loc = num(d.location);
  const summary = typeof p.summary === "string" ? p.summary : null;
  const flag = p.flag;
  if (
    f == null || sen == null || ind == null || sta == null || loc == null ||
    summary == null
  ) {
    return null;
  }
  const validFlags: FitFlag[] = [
    "none",
    "relocation_required",
    "level_mismatch",
    "ic_role",
    "bv_role",
    "partnerships_specialist",
  ];
  if (typeof flag !== "string" || !validFlags.includes(flag as FitFlag)) {
    return null;
  }

  // New: level_recommendation (required) + bv_reasoning (required when BV).
  const validLevels: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];
  const levelRaw = p.level_recommendation;
  if (typeof levelRaw !== "string" || !validLevels.includes(levelRaw as Level)) {
    return null;
  }
  let levelRecommendation = levelRaw as Level;
  const bvReasoning = typeof p.bv_reasoning === "string" ? p.bv_reasoning : "";

  const dimensions = {
    function: f,
    seniority: sen,
    industry: ind,
    stage: sta,
    location: loc,
  };
  const f_flag = flag as FitFlag;

  // Internal-consistency enforcement. Hard flags (bv_role, relocation,
  // level_mismatch) still force a specific level — those are policy
  // decisions. ic_role and partnerships_specialist are now SOFT in the
  // prompt — Sonnet can elevate them to HIGH or drop them to LOW based
  // on resume↔JD alignment, so no code-side cap. The numerical IC
  // score cap (rubric.icRoleCap) still applies via computeScore() as a
  // separate guard.
  //
  // BV → BV upgrade is still allowed: if Sonnet flags bv_role it must
  // mean BV; downgrades to anything else would silently lose BV signal.
  if (f_flag === "bv_role" && levelRecommendation !== "BV") {
    console.warn(
      `[fit] flag=bv_role but level_recommendation=${levelRecommendation} — overriding level to BV`,
    );
    levelRecommendation = "BV";
  }
  if (
    (f_flag === "relocation_required" ||
      f_flag === "level_mismatch") &&
    levelRecommendation !== "LOW"
  ) {
    console.warn(
      `[fit] flag=${f_flag} but level_recommendation=${levelRecommendation} — overriding level to LOW`,
    );
    levelRecommendation = "LOW";
  }

  // BV without reasoning is a contract violation — Sonnet must justify
  // every BV assignment with the title pattern + seniority quote.
  if (levelRecommendation === "BV" && !bvReasoning.trim()) {
    console.warn(`[fit] BV without bv_reasoning — downgrading to HIGH`);
    levelRecommendation = "HIGH";
  }

  return {
    dimensions,
    score: computeScore(dimensions, f_flag, rubric),
    summary,
    flag: f_flag,
    levelRecommendation,
    bvReasoning: levelRecommendation === "BV" ? bvReasoning : "",
  };
}

// Two-tier scoring path. Replaces the old single-tier Sonnet-on-every-
// row approach. For each unscored desc-capable row:
//   1. Fetch description.
//   2. Sonnet deep-score (single tier, no Haiku gate). Persists
//      fit_score + level + bv flag in one pass.
//
// Single-tier rationale: the 2-tier funnel (Haiku triage → Sonnet on
// escalation) saved $0.70/month at our volume (cost analysis
// 2026-05-25), which wasn't worth the calibration loop or the false-
// negatives at the Haiku gate. With ~465 BV/HIGH/MEDIUM rows/month,
// all-Sonnet runs ~$5.63/mo — well under the $35/mo score cap.
//
// Backwards-compat:
//   - Existing rows with tier1_score set (from the legacy 2-tier
//     era) keep that audit data; the new path just doesn't write it.
//   - pending_bv_verification rows from the legacy era still get
//     picked up first via the pendingBv pop so they finally resolve.
//
// Cap-fallback behavior comes from db/scoring-caps:
//   - Sonnet cap hit → skip, retry next tick or next month.
//   - Total cap hit → hard stop, no more AI calls this tick.
//
// Run from /api/cron/score after /api/cron/scan. Budget keeps us
// inside Vercel Hobby's 60s function ceiling.
// Score eligible user_matches rows for a single user. Phase 5: this
// replaces the pre-multi-tenant scoreUnscoredEligibleFromDb. The cron
// /api/cron/score loops every user with cap > 0 + onboarding done
// and calls this once each.
export async function scoreUnscoredEligibleForUser(
  userId: string,
  opts: {
    limit?: number;
    timeBudgetMs?: number;
    rubric?: ScoringRubric;
  },
): Promise<{
  scored: number;
  pendingBvProcessed: number;
  skipped: number;
  errored: number;
  remaining: number;
}> {
  const limit = opts.limit ?? 8;
  const timeBudgetMs = opts.timeBudgetMs ?? 45_000;
  const rubric = opts.rubric ?? DEFAULT_RUBRIC;
  const start = Date.now();

  const db = getDb();

  // Common shape: every queue row carries the global match facts
  // (title, location, etc.) AND the user's per-user state (tier1_*,
  // pending_bv, status). Joining once + projecting both is cheaper
  // than two queries.
  const joinedSelect = {
    id: matches.id,
    ats: matches.ats,
    companySlug: matches.companySlug,
    companyDisplayName: matches.companyDisplayName,
    jobId: matches.jobId,
    title: matches.title,
    location: matches.location,
    firstSeen: matches.firstSeen,
    closedAt: matches.closedAt,
    // Per-user state from user_matches:
    level: userMatches.level,
    status: userMatches.status,
    tier1Score: userMatches.tier1Score,
    tier1Confidence: userMatches.tier1Confidence,
    tier1IsPotentialBv: userMatches.tier1IsPotentialBv,
    tier1QuickTake: userMatches.tier1QuickTake,
    pendingBvVerification: userMatches.pendingBvVerification,
    fitScore: userMatches.fitScore,
  };

  // Pop 1: pending_bv_verification = true → auto-pickup retroactive
  // Tier-2. These already have Tier-1 fields populated; just need
  // Sonnet to verify the BV claim.
  const pendingBv = await db
    .select(joinedSelect)
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        eq(userMatches.pendingBvVerification, true),
        inArray(matches.ats, ALL_ATSES),
        ne(userMatches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    )
    .orderBy(desc(matches.firstSeen));

  // Pop 2: Tier-1 not yet run for this user. Per-user tier1_score
  // means each user does their own Tier-1 pass against their own
  // resume.
  //
  // FIFO by first_seen (oldest unscored first). Previously DESC, which
  // starved older rows: each scan adds ~50 fresh rows/day and the cron
  // tick limit (8) couldn't drain them faster than they arrived, so
  // rows that didn't make the first 8 in their initial tick never got
  // scored. With ASC, the cron services the longest-waiting row first
  // within each level. Steady-state drain rate (192/day) > add rate, so
  // freshly-added rows still get scored within hours; the bias just
  // prevents permanent starvation of the queue tail.
  const fresh = await db
    .select(joinedSelect)
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        isNull(userMatches.tier1Score),
        isNull(userMatches.fitScore),
        inArray(userMatches.level, ["BV", "HIGH", "MEDIUM"]),
        inArray(matches.ats, ALL_ATSES),
        ne(userMatches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    )
    .orderBy(matches.firstSeen);

  // Process pending BV first (high-value), then fresh sorted by level
  // so BV/HIGH classifier candidates score first within budget.
  const freshSorted = fresh.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
  );
  const work = [...pendingBv, ...freshSorted].slice(0, limit);
  const totalPending = pendingBv.length + freshSorted.length;

  let scored = 0;
  let pendingBvProcessed = 0;
  let skipped = 0;
  let errored = 0;

  for (const m of work) {
    if (Date.now() - start > timeBudgetMs) {
      console.warn(
        `[fit] [user ${userId.slice(0, 8)}] time budget exhausted (${timeBudgetMs}ms) — bailing with ${scored} processed, ${totalPending - (scored + skipped + errored)} remaining`,
      );
      break;
    }

    const isPendingBvRow = m.pendingBvVerification;

    // Total-cap check up front for both paths. Hard stop if hit.
    const totalSpendStatus = await checkSpend(userId, "triage");
    if (totalSpendStatus.totalCapReached) {
      console.warn(
        `[fit] [user ${userId.slice(0, 8)}] total monthly cap reached ($${totalSpendStatus.totalSpent.toFixed(2)}/$${totalSpendStatus.totalCap.toFixed(2)}) — aborting tick`,
      );
      break;
    }

    if (isPendingBvRow) {
      // ──────────────────────────────────────────────────────────
      // Pending-BV auto-pickup path: Tier-1 already done, run Tier-2
      // ──────────────────────────────────────────────────────────
      const sonnetStatus = await checkSpend(userId, "score");
      if (sonnetStatus.capReached || sonnetStatus.totalCapReached) {
        // Still can't verify. Leave the row alone (it'll be picked up
        // next tick or next month).
        skipped++;
        continue;
      }

      const tier1: Tier1Result = {
        tier1_score: parseFloat(m.tier1Score ?? "0"),
        confidence: (m.tier1Confidence as "low" | "medium" | "high") ?? "low",
        quick_take: m.tier1QuickTake ?? "",
        is_potential_bv: m.tier1IsPotentialBv ?? false,
      };
      const result = await runTier2OnRow(userId, m, tier1, rubric);
      if (result === "ok") {
        scored++;
        pendingBvProcessed++;
      } else if (result === "skip_no_desc") {
        skipped++;
      } else {
        errored++;
      }
      continue;
    }

    // ──────────────────────────────────────────────────────────
    // Fresh row path: direct-to-Sonnet (no Haiku gate)
    // ──────────────────────────────────────────────────────────
    const sonnetStatus = await checkSpend(userId, "score");
    if (sonnetStatus.capReached || sonnetStatus.totalCapReached) {
      console.warn(
        `[fit] [user ${userId.slice(0, 8)}] score cap reached ($${sonnetStatus.spent.toFixed(2)}/$${sonnetStatus.cap.toFixed(2)}) — skipping ${m.companySlug}/${m.jobId}`,
      );
      skipped++;
      continue;
    }

    const result = await runTier2OnRow(userId, m, undefined, rubric);
    if (result === "ok") {
      scored++;
    } else if (result === "skip_no_desc") {
      skipped++;
    } else {
      errored++;
    }
  }

  return {
    scored,
    pendingBvProcessed,
    skipped,
    errored,
    remaining: Math.max(0, totalPending - (scored + skipped + errored)),
  };
}

// Inner helper: run Tier-2 on a row using the given Tier-1 result.
// Returns "ok" on success, "skip_no_desc" if JD fetch fails,
// "error" otherwise. Used by both the fresh-row path (with the JD
// already fetched) and the pending-BV-verification path (which needs
// to re-fetch the JD).
type Tier2Outcome = "ok" | "skip_no_desc" | "error";

// Loose work-row shape — covers both Drizzle's $inferSelect for
// matches and the joined-projection shape from
// scoreUnscoredEligibleForUser. We only read the fields the function
// needs.
type WorkRow = {
  id: string;
  ats: typeof matches.$inferSelect.ats;
  companySlug: string;
  companyDisplayName: string;
  jobId: string;
  title: string;
  location: string;
  tier1Score: string | null;
};

async function runTier2OnRow(
  userId: string,
  m: WorkRow,
  tier1: Tier1Result | undefined,
  rubric: ScoringRubric,
  preFetchedDesc?: string,
): Promise<Tier2Outcome> {
  // Write Tier-1 fields up front so they survive even if Tier-2 errors.
  // persistScore will later overwrite level (with level_recommendation),
  // bvReasoning, and pendingBvVerification — but the Tier-1 audit
  // trail stays intact regardless. Skip when tier1 is undefined (all-
  // Sonnet path: no Haiku ran) or when tier1Score is already on the
  // row (pending-BV-pickup path).
  if (tier1 && m.tier1Score == null) {
    await writeTier1Fields(userId, m.id, tier1);
  }

  let desc = preFetchedDesc;
  if (!desc) {
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      console.log(`[fit] skip ${m.companySlug}/${m.jobId} — no description`);
      return "skip_no_desc";
    }
    desc = extractScoringText(rawDesc);
  }

  const sector: Sector = await sectorForSlug(m.companySlug);
  const out = await scoreFitWithClaude({
    userId,
    matchId: m.id,
    title: m.title,
    company: m.companyDisplayName,
    companySlug: m.companySlug,
    location: m.location,
    description: desc,
    sector,
    tier1,
    rubric,
  });

  if (!out.ok) {
    if (out.reason === "cap_reached" || out.reason === "missing_key") {
      console.warn(`[fit] tier-2 aborted: ${out.reason}`);
    }
    return "error";
  }

  try {
    await persistScore(
      userId,
      m.id,
      out.fit,
      out.tokensIn,
      out.tokensOut,
      out.costUsd,
      rubric,
      {
        cacheReadTokens: out.cacheReadTokens,
        cacheWriteTokens: out.cacheWriteTokens,
      },
    );
    console.log(
      `[fit]   sonnet={dims:[f:${out.fit.dimensions.function.toFixed(1)}, s:${out.fit.dimensions.seniority.toFixed(1)}, i:${out.fit.dimensions.industry.toFixed(1)}, st:${out.fit.dimensions.stage.toFixed(1)}, l:${out.fit.dimensions.location.toFixed(1)}], score:${out.fit.score.toFixed(1)}, level:${out.fit.levelRecommendation}, flag:${out.fit.flag}, $${out.costUsd.toFixed(4)}}` +
        (out.fit.levelRecommendation === "BV" ? ` bv_reasoning:"${out.fit.bvReasoning}"` : ""),
    );
    return "ok";
  } catch (err) {
    console.error(`[fit] persist failed for ${m.id}:`, err);
    return "error";
  }
}

// Write Tier-1 columns on a user_matches row. Only invoked for rows
// that came through the legacy 2-tier path — the all-Sonnet path
// passes undefined for tier1 and skips this entirely. Kept so the
// pending-BV-verification auto-pickup (which still inherits its
// Tier-1 result from the DB row) preserves the historical audit
// trail when Tier-2 runs retroactively.
async function writeTier1Fields(
  userId: string,
  matchId: string,
  tier1: Tier1Result,
): Promise<void> {
  const db = getDb();
  await db
    .update(userMatches)
    .set({
      tier1Score: tier1.tier1_score.toFixed(1),
      tier1Confidence: tier1.confidence,
      tier1IsPotentialBv: tier1.is_potential_bv,
      tier1QuickTake: tier1.quick_take,
      updatedAt: sql`now()`,
    })
    .where(and(eq(userMatches.userId, userId), eq(userMatches.matchId, matchId)));
}

// Decides whether a row appears in the daily digest. Wider than just
// "level IN (BV, HIGH)": lets fit_score above alertThreshold in even
// when level is MEDIUM (a classifier-MEDIUM that Claude scored at 7.7
// is a strong match worth showing — the levelFromFit HIGH threshold
// of 8.0 leaves these out of the level column).
//
// Flag suppressions: hard exclusions and level_mismatch are categorical
// rejects — never alert. ic_role is NO LONGER auto-suppressed: under
// the soft-flag rules, Sonnet can elevate strong-fit IC AE roles to
// HIGH or keep them at MEDIUM with high score; either way they should
// surface if the alignment is there. The score / level check below
// gates them naturally — weak-fit IC roles land at LOW.
export function shouldAlert(
  row: {
    level: Level;
    fitScore: number | null;
    fitFlag: FitFlag | null;
  },
  rubric: ScoringRubric = DEFAULT_RUBRIC,
): boolean {
  if (row.fitFlag && rubric.hardExclusions.includes(row.fitFlag)) return false;
  if (row.fitFlag === "level_mismatch") return false;

  if (row.fitFlag === "bv_role") return true;

  if (row.fitScore == null) {
    return row.level === "BV" || row.level === "HIGH";
  }

  return row.fitScore >= rubric.alertThreshold;
}

// Map fit_score + flag to a display level. BV is flag-driven (true BV
// roles only); HIGH/MED/LOW are score-banded. This produces the
// "level" column for any row that has been Claude-scored. Unscored
// rows keep their classifier-set level.
export function levelFromFit(score: number, flag: FitFlag): Level {
  if (flag === "bv_role") return "BV";
  if (score >= 8.0) return "HIGH";
  if (score >= 6.0) return "MEDIUM";
  return "LOW";
}

// Persist a successful Sonnet score. Writes:
//   - fit_* columns from Sonnet's dimension scores
//   - level column from Sonnet's level_recommendation (NOT levelFromFit)
//   - bv_reasoning when level=BV
//   - clears pending_bv_verification (Sonnet has now verified)
//   - api_usage row with purpose='score'
//
// levelFromFit() is still exported and used by the legacy direct-score
// path (callers without Tier-1 escalation) — but the production
// pipeline always has Sonnet's level_recommendation.
export async function persistScore(
  userId: string,
  matchId: string,
  fit: FitScore,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  _rubric: ScoringRubric = DEFAULT_RUBRIC,
  opts?: { cacheReadTokens?: number; cacheWriteTokens?: number },
): Promise<void> {
  const db = getDb();
  await db
    .update(userMatches)
    .set({
      fitScore: fit.score.toFixed(1),
      fitSummary: fit.summary,
      fitFlag: fit.flag,
      level: fit.levelRecommendation,
      bvReasoning: fit.bvReasoning || null,
      pendingBvVerification: false,
      updatedAt: sql`now()`,
    })
    .where(and(eq(userMatches.userId, userId), eq(userMatches.matchId, matchId)));
  await db.insert(apiUsage).values({
    userId,
    matchId,
    tokensIn: tokensIn + (opts?.cacheReadTokens ?? 0) + (opts?.cacheWriteTokens ?? 0),
    tokensOut,
    costUsd: costUsd.toFixed(6),
    model: MODEL,
    purpose: "score",
  });
}
