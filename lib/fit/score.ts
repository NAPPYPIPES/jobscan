import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, companies, matches } from "@/db/schema";
import { LEVEL_ORDER, type Level, type Sector } from "@/lib/scan/types";
import { sectorForSlug } from "@/db/targets";
import { extractScoringText, fetchDescription } from "./fetch-description";
import { DEFAULT_RUBRIC, formatRubricForPrompt, type ScoringRubric } from "./rubric";
import { getUserProfile, getRawResume } from "@/db/profile";
import { checkSpend } from "./spendCaps";
import { decideEscalation, levelFromTier1, type Tier1Result } from "./escalation";
import { triageRoleWithHaiku } from "./triage";
import { getScoringCaps } from "@/db/scoring-caps";

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

// Cap check now reads from config-backed scoring_caps via spendCaps.ts.
// Hard cap = score-purpose cap or total cap (whichever hits first).
// Soft warn at 80% of score cap so logs surface the approach.
const defaultMonthlyCapCheck: CapCheckFn = async () => {
  const status = await checkSpend("score");
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

export type FitFlag =
  | "none"
  | "healthcare_excluded"
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

// Sum of api_usage.cost_usd for the current calendar month (UTC). Used
// as the gate before each scoring call. Indexed on called_at so this
// stays cheap even as the ledger grows.
export async function getCurrentMonthSpend(): Promise<number> {
  const db = getDb();
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text` })
    .from(apiUsage)
    .where(gte(apiUsage.calledAt, start));
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
  rubric: ScoringRubric,
): Promise<Anthropic.Messages.TextBlockParam[]> {
  const raw = await getRawResume();
  const profile = await getUserProfile();

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
FLAG RULES — set exactly one
================================================================
- "healthcare_excluded": role is healthcare-focused — drop industry to 0 and set this flag.
- "relocation_required": role requires relocation outside the candidate's allowed locations.
- "level_mismatch": role is far below the candidate's target seniority.
- "ic_role": individual-contributor sales role (AE, Sales Rep) with no team-management scope. Consumer applies the IC cap automatically.
- "bv_role": role's primary function is Business Value Consulting / Value Engineering per the title patterns above AND seniority is Director-and-above or staff-IC. Set whenever level_recommendation = "BV".
- "partnerships_specialist": title contains "Partnerships" or "Alliances" — softer match.
- "none": none of the above.

================================================================
LEVEL_RECOMMENDATION — your authoritative level assignment
================================================================
This overrides the score→level mapping. Use these explicit rules:

BV — assign ONLY if:
  (a) the title contains explicit business-value function words (Business Value / Value Consulting / Value Engineering / Value Realization / Value Advisory / Value Architecture / Value Services), AND
  (b) seniority is Director-and-above OR staff-IC equivalent (Principal / Staff / Lead / Senior Principal).
  Do NOT inflate other strong-fit roles to BV — they are HIGH instead. When in doubt about title fit for BV, assign HIGH. BV is rare by design.

HIGH — strong fits across function + seniority + industry that are NOT BV-specific. Examples:
  - VP GTM / VP Sales / VP Revenue at an AI-native or enterprise SaaS company
  - Head of Strategic Sales in financial services
  - Director of Enterprise Sales at Series B-D
  - "Value Consultant" at Manager level (matches function but missing seniority for BV)

MEDIUM — one or two dimensions clearly off but worth surfacing:
  - Right function, wrong stage
  - Right seniority, adjacent function
  - Right function + seniority, weak industry fit

LOW — adjacent or stretched roles not worth alerting on, or hard exclusions.

Internal consistency required:
  - flag = "bv_role"             → level_recommendation = "BV"
  - flag = "healthcare_excluded" → level_recommendation = "LOW"
  - flag = "level_mismatch"      → level_recommendation = "LOW"
  - flag = "ic_role"             → level_recommendation ≤ "MEDIUM"
  - flag = "relocation_required" → level_recommendation = "LOW"
  - flag = "partnerships_specialist" → level_recommendation ≤ "MEDIUM"

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
             titles (Principal, Staff, Lead, "Value Engineer") for
             roles that other companies would title Director. Score
             accordingly:
                 10  Senior Director / VP / Head of BV at any company,
                     OR staff-IC titles ("Value Engineer", "Senior
                     Value Engineer", "Principal Value Advisor",
                     "Business Value Consultant") at top-tier AI,
                     SaaS, or fintech companies (OpenAI, Anthropic,
                     Databricks, Glean, Cursor, Sierra, Decagon,
                     Stripe, MongoDB, Snowflake, Cohere, Mistral,
                     Twilio, Plaid, Brex, etc).
                  9  "Value Consultant" or "Value Engineer" titles at
                     companies further from the top-tier AI/SaaS
                     cluster, OR Manager-of-Value-Consultants at any
                     company.
                  8  Senior Manager of a small Value team.
                  7  Manager-level Value Consultant (under target —
                     usually downgrade to HIGH not BV).
             Do NOT use the generic "VP/SVP = 10, Director = 7" anchor
             from the rubric — that scale assumes a non-BV target.

  industry:  AI-native (OpenAI, Anthropic, Databricks, Cohere, Glean,
             Cursor, Sierra) and enterprise SaaS / fintech BV roles
             score 9-10. Only downgrade for genuinely off-thesis
             companies (consumer B2C, crypto-only, healthcare).

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
  - "Value Engineer, AI Success - NYC" at OpenAI                      → 9.9 (basically the same job; AI-native; NYC)
  - "Business Value Consultant, Financial Services" at Databricks     → 9.9 (same vertical + BV title at a top AI infra co)
  - "Business Value Consultant" at Glean                              → 9.7 (BV title at strong AI infra co; minor industry softness)
  - "Business Value Consultant" at Decagon                            → 9.6 (BV title at AI-native scale-up)
  - "Senior Value Engineer" at Twilio                                 → 9.3 (BV title, AI-adjacent but enterprise comm not AI-native)
  - "Director of Value Engineering" at MongoDB                        → 9.7
  - "Value Consultant" at Manager level at any company                → NOT BV → assign HIGH
  - "Value Engineer" at a healthcare-vertical company                 → BV but flag healthcare_excluded, level LOW

Crucial: under the BV-specific seniority scale, "staff-IC at a top AI
or enterprise SaaS company" (Principal / Staff / Lead / Senior Principal /
"Value Engineer" titled as IC) maps to seniority = 9, NOT 7. That's the
candidate's exact target seniority band for BV practitioner roles.
Director-of-BV-Practice = 10. Anything below Manager-of-Value-Consultants
in a BV title is the role being under-leveled for the candidate, not the
candidate being a fit for an under-leveled role.

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
  "flag": "none" | "healthcare_excluded" | "relocation_required" | "level_mismatch" | "ic_role" | "bv_role" | "partnerships_specialist",
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
  // Pluggable cap check — defaults to the month-to-date cap.
  capCheck?: CapCheckFn;
  // Pluggable rubric — defaults to DEFAULT_RUBRIC.
  rubric?: ScoringRubric;
}): Promise<ScoreResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "missing_key" };
  }

  // Idempotency: if a prior scan already scored this row, don't pay
  // again on a retry. fit_score IS NOT NULL means we have a result.
  if (!args.force) {
    const db = getDb();
    const existing = await db
      .select({ fitScore: matches.fitScore })
      .from(matches)
      .where(and(eq(matches.id, args.matchId)))
      .limit(1);
    if (existing[0]?.fitScore != null) {
      return { ok: false, reason: "already_scored" };
    }
  }

  const cap = await (args.capCheck ?? defaultMonthlyCapCheck)();
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
  const systemBlocks = await buildSystemBlocks(rubric);

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
    "healthcare_excluded",
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

  // Internal-consistency enforcement. If the model emitted an
  // inconsistent flag + level pair, log a warning and prefer the
  // level_recommendation (the redesigned authority). The model's
  // flag stays as-is for filtering purposes (e.g. ic_role still
  // applies the IC cap deterministically), but the level reflects
  // Sonnet's higher-order judgment.
  if (f_flag === "bv_role" && levelRecommendation !== "BV") {
    console.warn(
      `[fit] flag=bv_role but level_recommendation=${levelRecommendation} — overriding level to BV`,
    );
    levelRecommendation = "BV";
  }
  if (
    (f_flag === "healthcare_excluded" ||
      f_flag === "relocation_required" ||
      f_flag === "level_mismatch") &&
    levelRecommendation !== "LOW"
  ) {
    console.warn(
      `[fit] flag=${f_flag} but level_recommendation=${levelRecommendation} — overriding level to LOW`,
    );
    levelRecommendation = "LOW";
  }
  if (
    (f_flag === "ic_role" || f_flag === "partnerships_specialist") &&
    (levelRecommendation === "BV" || levelRecommendation === "HIGH")
  ) {
    console.warn(
      `[fit] flag=${f_flag} but level_recommendation=${levelRecommendation} — capping at MEDIUM`,
    );
    levelRecommendation = "MEDIUM";
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
//   1. Tier-1 (Haiku) triage — cheap; reads title + 600-char snippet +
//      company description + full resume. Returns score, confidence,
//      quick_take, is_potential_bv.
//   2. Escalation decision per the policy in lib/fit/escalation.ts.
//   3. Tier-2 (Sonnet) deep-score if escalated — uses full JD + Haiku's
//      take + level_recommendation rules.
//   4. Persist Tier-1 fields always; Tier-2 fields when escalated.
//
// Also handles the pending-BV-verification auto-pickup: rows that
// flagged BV at Tier-1 but couldn't escalate (Sonnet cap hit) get
// retroactive Tier-2 once budget allows. Picked up FIRST each tick so
// the "potential gold" rows don't starve.
//
// Cap-fallback behavior comes from db/scoring-caps:
//   - Triage cap hit → keyword classifier (existing level stays).
//   - Sonnet cap hit, not BV → trust Tier-1 with MEDIUM ceiling.
//   - Sonnet cap hit, BV → persist as HIGH + pending_bv_verification.
//   - Total cap hit → hard stop, no more AI calls this tick.
//
// Run from /api/cron/score after /api/cron/scan. Budget keeps us
// inside Vercel Hobby's 60s function ceiling.
export async function scoreUnscoredEligibleFromDb(opts: {
  limit?: number;
  timeBudgetMs?: number;
  rubric?: ScoringRubric;
}): Promise<{
  scored: number;
  triagedOnly: number;
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
  const caps = await getScoringCaps();

  // Pop 1: pending_bv_verification = true → auto-pickup retroactive
  // Tier-2. These already have Tier-1 fields populated; just need
  // Sonnet to verify the BV claim.
  const pendingBv = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.pendingBvVerification, true),
        inArray(matches.ats, ["greenhouse", "ashby", "lever"]),
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    )
    .orderBy(desc(matches.firstSeen));

  // Pop 2: Tier-1 not yet run (tier1_score IS NULL) on otherwise
  // eligible rows. The old query keyed on fit_score IS NULL; switching
  // to tier1_score IS NULL covers everything fit_score IS NULL did
  // PLUS the rows that have a Tier-1 result but no Tier-2 yet — but
  // those are handled by pop 1 or by levelFromTier1 already, so we
  // don't re-process them.
  const fresh = await db
    .select()
    .from(matches)
    .where(
      and(
        isNull(matches.tier1Score),
        isNull(matches.fitScore),
        inArray(matches.level, ["BV", "HIGH", "MEDIUM"]),
        inArray(matches.ats, ["greenhouse", "ashby", "lever"]),
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
      ),
    )
    .orderBy(desc(matches.firstSeen));

  // Process pending BV first (high-value), then fresh sorted by level
  // so BV/HIGH classifier candidates score first within budget.
  const freshSorted = fresh.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
  );
  const work = [...pendingBv, ...freshSorted].slice(0, limit);
  const totalPending = pendingBv.length + freshSorted.length;

  let scored = 0;
  let triagedOnly = 0;
  let pendingBvProcessed = 0;
  let skipped = 0;
  let errored = 0;

  for (const m of work) {
    if (Date.now() - start > timeBudgetMs) {
      console.warn(
        `[fit] time budget exhausted (${timeBudgetMs}ms) — bailing with ${scored + triagedOnly} processed, ${totalPending - (scored + triagedOnly + skipped + errored)} remaining`,
      );
      break;
    }

    const isPendingBvRow = m.pendingBvVerification;

    // Total-cap check up front for both paths. Hard stop if hit.
    const totalSpendStatus = await checkSpend("triage");
    if (totalSpendStatus.totalCapReached) {
      console.warn(
        `[fit] total monthly cap reached ($${totalSpendStatus.totalSpent.toFixed(2)}/$${totalSpendStatus.totalCap.toFixed(2)}) — aborting tick`,
      );
      break;
    }

    if (isPendingBvRow) {
      // ──────────────────────────────────────────────────────────
      // Pending-BV auto-pickup path: Tier-1 already done, run Tier-2
      // ──────────────────────────────────────────────────────────
      const sonnetStatus = await checkSpend("score");
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
      const result = await runTier2OnRow(m, tier1, rubric);
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
    // Fresh row path: Tier-1 first, then maybe Tier-2
    // ──────────────────────────────────────────────────────────
    const triageStatus = await checkSpend("triage");
    if (triageStatus.capReached || triageStatus.totalCapReached) {
      // Triage cap reached — caller's policy is keyword_classifier
      // fallback, which means leaving the existing classifier-set
      // level alone. Skip without burning budget.
      console.warn(
        `[fit] triage cap reached ($${triageStatus.spent.toFixed(2)}/$${triageStatus.cap.toFixed(2)}) — skipping ${m.companySlug}/${m.jobId}`,
      );
      skipped++;
      continue;
    }

    // Need the JD for the snippet. Workday is excluded by the SQL
    // filter so this should always succeed for desc-capable ATSs.
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      skipped++;
      console.log(`[fit] skip ${m.companySlug}/${m.jobId} — no description`);
      continue;
    }
    const extracted = extractScoringText(rawDesc);

    // Tier-1: Haiku triage.
    const triageOut = await triageRoleWithHaiku({
      title: m.title,
      company: m.companyDisplayName,
      companySlug: m.companySlug,
      location: m.location,
      descriptionSnippet: extracted,
    });

    if (!triageOut.ok) {
      console.warn(
        `[fit] tier-1 failed for ${m.companySlug}/${m.jobId} (${triageOut.reason}) — falling back to classifier level`,
      );
      errored++;
      continue;
    }

    // Log triage api_usage row regardless of escalation decision.
    await insertTriageUsage(m.id, triageOut);

    // Escalation decision.
    const sonnetStatus = await checkSpend("score");
    const sonnetCapReached =
      sonnetStatus.capReached || sonnetStatus.totalCapReached;
    const decision = decideEscalation(triageOut.tier1, caps, sonnetCapReached);

    if (decision.escalate) {
      // Tier-2: Sonnet deep-score with Tier-1 context.
      const result = await runTier2OnRow(
        m,
        triageOut.tier1,
        rubric,
        extracted,
      );

      if (result === "ok") {
        scored++;
        console.log(
          `[fit] match=${m.id.slice(0, 8)} haiku={score:${triageOut.tier1.tier1_score.toFixed(1)}, conf:${triageOut.tier1.confidence}, bv:${triageOut.tier1.is_potential_bv}} → escalate (${decision.reason}) — see next line`,
        );
      } else if (result === "skip_no_desc") {
        // Shouldn't happen since we already fetched description, but defensive.
        skipped++;
      } else {
        errored++;
      }
      continue;
    }

    // Not escalated. Persist Tier-1 only. Level capped at MEDIUM
    // (HIGH/BV require Sonnet verification per the design).
    let level: Level;
    let pendingBv = false;
    if (decision.reason === "potential_bv_capped") {
      // Sonnet cap hit + BV flagged. Persist as HIGH with pending flag
      // so the next tick (or next month) picks it up via pop 1.
      level = "HIGH";
      pendingBv = true;
    } else {
      level = levelFromTier1(triageOut.tier1.tier1_score);
    }

    await persistTier1Only(m.id, triageOut.tier1, level, pendingBv);
    triagedOnly++;
    console.log(
      `[fit] match=${m.id.slice(0, 8)} haiku={score:${triageOut.tier1.tier1_score.toFixed(1)}, conf:${triageOut.tier1.confidence}, bv:${triageOut.tier1.is_potential_bv}} → no_escalate (${decision.reason}) → level:${level}${pendingBv ? " pending_bv=true" : ""}`,
    );
  }

  return {
    scored,
    triagedOnly,
    pendingBvProcessed,
    skipped,
    errored,
    remaining: Math.max(0, totalPending - (scored + triagedOnly + skipped + errored)),
  };
}

// Inner helper: run Tier-2 on a row using the given Tier-1 result.
// Returns "ok" on success, "skip_no_desc" if JD fetch fails,
// "error" otherwise. Used by both the fresh-row path (with the JD
// already fetched) and the pending-BV-verification path (which needs
// to re-fetch the JD).
type Tier2Outcome = "ok" | "skip_no_desc" | "error";

async function runTier2OnRow(
  m: typeof matches.$inferSelect,
  tier1: Tier1Result,
  rubric: ScoringRubric,
  preFetchedDesc?: string,
): Promise<Tier2Outcome> {
  // Write Tier-1 fields up front so they survive even if Tier-2 errors.
  // persistScore will later overwrite level (with level_recommendation),
  // bvReasoning, and pendingBvVerification — but the Tier-1 audit
  // trail stays intact regardless. Skip for the pending-BV-pickup path
  // where Tier-1 fields are already on the row.
  if (m.tier1Score == null) {
    await writeTier1Fields(m.id, tier1);
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

// Write just the Tier-1 columns on a matches row. Used before
// escalation so the audit trail lands even if Tier-2 fails. Does NOT
// touch level — that's controlled by persistTier1Only (no escalation)
// or persistScore (escalation).
async function writeTier1Fields(
  matchId: string,
  tier1: Tier1Result,
): Promise<void> {
  const db = getDb();
  await db
    .update(matches)
    .set({
      tier1Score: tier1.tier1_score.toFixed(1),
      tier1Confidence: tier1.confidence,
      tier1IsPotentialBv: tier1.is_potential_bv,
      tier1QuickTake: tier1.quick_take,
      updatedAt: sql`now()`,
    })
    .where(eq(matches.id, matchId));
}

// Persist Tier-1 results without a Tier-2 score. Updates level + Tier-1
// columns; leaves fit_score NULL. Writes the api_usage row for the
// triage call.
async function persistTier1Only(
  matchId: string,
  tier1: Tier1Result,
  level: Level,
  pendingBv: boolean,
): Promise<void> {
  const db = getDb();
  await db
    .update(matches)
    .set({
      tier1Score: tier1.tier1_score.toFixed(1),
      tier1Confidence: tier1.confidence,
      tier1IsPotentialBv: tier1.is_potential_bv,
      tier1QuickTake: tier1.quick_take,
      pendingBvVerification: pendingBv,
      level,
      updatedAt: sql`now()`,
    })
    .where(eq(matches.id, matchId));
}

// Insert the triage-purpose api_usage row. Tier-1 fields are also
// written on the matches row separately. Cost ledger here tracks per-
// purpose spend so checkSpend("triage") returns accurate monthly sums.
async function insertTriageUsage(
  matchId: string,
  out: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  },
): Promise<void> {
  const db = getDb();
  await db.insert(apiUsage).values({
    matchId,
    tokensIn: out.tokensIn + out.cacheReadTokens + out.cacheWriteTokens,
    tokensOut: out.tokensOut,
    costUsd: out.costUsd.toFixed(6),
    model: "claude-haiku-4-5-20251001",
    purpose: "triage",
  });

  // Also update the matches row with Tier-1 fields here so the data
  // lands even if Tier-2 fails or is skipped. Persisting again from
  // persistTier1Only is idempotent (last write wins on the same row).
  // For the escalation path, persistScore() later overwrites level
  // with Sonnet's level_recommendation.
}

// Decides whether a row appears in the daily digest. Wider than just
// "level IN (BV, HIGH)": lets fit_score above alertThreshold in even
// when level is MEDIUM (a classifier-MEDIUM that Claude scored at 7.7
// is a strong match worth showing — the levelFromFit HIGH threshold
// of 8.0 leaves these out of the level column). Flag-driven
// suppressions take precedence so an IC sales role can't sneak through
// on score alone.
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
  if (row.fitFlag === "ic_role") return false;

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
    .update(matches)
    .set({
      fitScore: fit.score.toFixed(1),
      fitSummary: fit.summary,
      fitFlag: fit.flag,
      level: fit.levelRecommendation,
      bvReasoning: fit.bvReasoning || null,
      pendingBvVerification: false,
      updatedAt: sql`now()`,
    })
    .where(eq(matches.id, matchId));
  await db.insert(apiUsage).values({
    matchId,
    tokensIn: tokensIn + (opts?.cacheReadTokens ?? 0) + (opts?.cacheWriteTokens ?? 0),
    tokensOut,
    costUsd: costUsd.toFixed(6),
    model: MODEL,
    purpose: "score",
  });
}
