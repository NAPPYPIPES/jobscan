import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, companies, matches } from "@/db/schema";
import { LEVEL_ORDER, type Level, type Sector } from "@/lib/scan/types";
import { sectorForSlug } from "@/db/targets";
import { extractScoringText, fetchDescription } from "./fetch-description";
import { DEFAULT_RUBRIC, formatRubricForPrompt, type ScoringRubric } from "./rubric";
import { getUserProfile } from "@/db/profile";

// Claude Sonnet 4.6 — accurate enough for rubric-driven scoring with
// reasonable cost at typical hobby volumes. Swap to Haiku for cheaper
// runs if you don't care about the marginal accuracy.
const MODEL = "claude-sonnet-4-6";

// Public Anthropic Sonnet 4.6 pricing as of 2026-05. Update if rates
// move — these multiply token counts into the cost ledger.
const INPUT_PER_MTOK = 3.0;
const OUTPUT_PER_MTOK = 15.0;

// Monthly spend caps. Soft = warn but proceed; hard = abort silently
// and leave fit_score null (the scan + classifier still run, the UI
// still works, the digest still sends — just no Claude scoring on
// new rows until next month).
const SOFT_CAP_USD = 35.0;
const HARD_CAP_USD = 40.0;

export type CapStatus = {
  hardReached: boolean;
  softReached: boolean;
  spend: number;
  label: string;
};
export type CapCheckFn = () => Promise<CapStatus>;

const defaultMonthlyCapCheck: CapCheckFn = async () => {
  const spend = await getCurrentMonthSpend();
  return {
    hardReached: spend >= HARD_CAP_USD,
    softReached: spend >= SOFT_CAP_USD,
    spend,
    label: `monthly $${SOFT_CAP_USD.toFixed(0)}/$${HARD_CAP_USD.toFixed(0)}`,
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
};

export type ScoreResult =
  | {
      ok: true;
      fit: FitScore;
      tokensIn: number;
      tokensOut: number;
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

// Build the dynamic system prompt by interpolating the user_profile.
// Profile may be null if the user hasn't run ingest-resume yet — in
// that case we substitute a generic "no candidate profile loaded"
// stanza that asks Claude to score industry/seniority neutrally from
// title + JD alone. Scores will be less personalized but the pipeline
// still runs.
async function buildSystemPrompt(rubric: ScoringRubric): Promise<string> {
  const profile = await getUserProfile();
  const profileBlock = profile
    ? [
        `CANDIDATE PROFILE:`,
        profile.parsedSummary,
        ``,
        `Years of experience: ${profile.yearsExperience ?? "(not stated)"}`,
        `Seniority level: ${profile.seniorityLevel ?? "(not stated)"}`,
        `Industries of experience: ${(profile.industries ?? []).join(", ") || "(none listed)"}`,
        `Functions: ${(profile.functions ?? []).join(", ") || "(none listed)"}`,
        `Target roles: ${(profile.targetRoles ?? []).join(", ") || "(none listed)"}`,
        `Hard exclusions: ${(profile.hardExclusions ?? []).join(", ") || "(none listed)"}`,
      ].join("\n")
    : [
        `CANDIDATE PROFILE:`,
        `(No candidate profile has been ingested yet — run \`npm run ingest-resume\`)`,
        `Score industry and seniority neutrally from the role title and JD alone.`,
        `Do not assume any specific industry expertise or seniority band.`,
      ].join("\n");

  const exclusions = (rubric.hardExclusions ?? []).join(", ") || "none";

  return `You are a job fit scorer for a specific candidate. Return only valid JSON, no other text.

${profileBlock}

COMPANY CONTEXT:
Each user message includes a one-sentence company description (or "(unknown)" if not yet seeded). Use it to score industry fit accurately. A candidate with enterprise SaaS + financial services background is a stronger fit at a company selling to enterprise business buyers than at a crypto infrastructure or consumer fintech company, even if the role titles look similar.

HARD EXCLUSIONS:
Flags that force a 0.0 overall score (set the matching flag and also drop the industry/location dimension to 0):
  ${exclusions}

Score the role on five dimensions (0-10 each) using the rubric in the user message. Do NOT compute the final fit_score — the consumer computes the weighted average and applies the IC cap deterministically. You assign the dimension scores, write a one-sentence summary, and set the flag.`;
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

  // Description is truncated to ~6000 chars (~1500 tokens). JDs longer
  // than that are usually boilerplate-bloated; the relevant signal is
  // in the first few paragraphs and the extractScoringText pass.
  const desc = args.description.length > 6000
    ? args.description.slice(0, 6000) + "…"
    : args.description;

  // Fetch company description at scoring time. One indexed PK lookup.
  const companyDescription = await getCompanyDescription(args.companySlug);

  const systemPrompt = await buildSystemPrompt(rubric);

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: buildUserMessage({
            title: args.title,
            company: args.company,
            companyDescription,
            location: args.location,
            description: desc,
            rubric,
          }),
        },
      ],
    });

    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const costUsd =
      (tokensIn / 1_000_000) * INPUT_PER_MTOK +
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

    return { ok: true, fit, tokensIn, tokensOut, costUsd };
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
  rubric: ScoringRubric;
}): string {
  return `Role to score:
Title: ${args.title}
Company: ${args.company}
Company description: ${args.companyDescription ?? "(unknown — score from title and JD only)"}
Location: ${args.location}
Description: ${args.description}

Scoring rubric:

${formatRubricForPrompt(args.rubric)}

FLAG RULES (set exactly one):
- "healthcare_excluded": role is healthcare-focused — set industry to 0 and use this flag
- "relocation_required": role requires relocation outside the user's allowed locations
- "level_mismatch": role is far below the candidate's target seniority (entry-level, Associate, etc.)
- "ic_role": role is an individual-contributor sales role (Account Executive, AE, Sales Rep) with no team management implied. Set this whenever the title is AE/IC sales — the consumer applies the IC cap automatically. Do not pre-cap the dimension scores.
- "bv_role": role's PRIMARY function is Business Value Consulting / Value Engineering / Value Services / Strategic Sales Support. Set this ONLY when the JD explicitly describes activities like building ROI models / value frameworks / executive briefings for F500 buyers. Do NOT set for: sales leadership (VP Sales), sales engineering, broad strategy/ops, marketing, account executives.
- "partnerships_specialist": role title contains "Partnerships" or "Alliances" at any seniority — the scoring path treats these as a softer match unless the JD explicitly describes general sales-leadership scope.
- "none": none of the above

Return this JSON exactly:
{
  "dimensions": {
    "function": X.X,
    "seniority": X.X,
    "industry": X.X,
    "stage": X.X,
    "location": X.X
  },
  "summary": "ONE short sentence (max 30 words) — what makes this role a strong/weak fit for this candidate",
  "flag": "none" | "healthcare_excluded" | "relocation_required" | "level_mismatch" | "ic_role" | "bv_role" | "partnerships_specialist"
}`;
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
// Returns null on any shape mismatch so the caller can mark
// parse_error and move on.
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
  const dimensions = {
    function: f,
    seniority: sen,
    industry: ind,
    stage: sta,
    location: loc,
  };
  const f_flag = flag as FitFlag;
  return {
    dimensions,
    score: computeScore(dimensions, f_flag, rubric),
    summary,
    flag: f_flag,
  };
}

// Decoupled scoring path. Queries the DB for unscored eligible rows
// (BV/HIGH/MEDIUM at any sector, GH/Ashby/Lever only since Workday has
// no description, dismissed excluded) and scores up to `limit` of them
// with a wall-clock budget. Re-fetches each description from the
// source ATS since we don't persist JDs.
//
// Run from /api/cron/score on the same cron tick as /api/cron/scan,
// chained sequentially. Conservative limits keep us well inside
// Vercel Hobby's 60s function ceiling — backlog is fine to clear over
// multiple runs since the cron fires hourly.
export async function scoreUnscoredEligibleFromDb(opts: {
  limit?: number;
  timeBudgetMs?: number;
  rubric?: ScoringRubric;
}): Promise<{ scored: number; skipped: number; errored: number; remaining: number }> {
  const limit = opts.limit ?? 8;
  const timeBudgetMs = opts.timeBudgetMs ?? 45_000;
  const rubric = opts.rubric ?? DEFAULT_RUBRIC;
  const start = Date.now();

  const db = getDb();
  // Eligibility: BV/HIGH/MEDIUM, dismissed not excluded by status
  // alone (would re-score dismissed rows on re-run; instead the
  // eligibility filter excludes status='dismissed'), only on ATSs
  // that provide descriptions (Workday is title-only).
  const candidates = await db
    .select()
    .from(matches)
    .where(
      and(
        isNull(matches.fitScore),
        inArray(matches.level, ["BV", "HIGH", "MEDIUM"]),
        inArray(matches.ats, ["greenhouse", "ashby", "lever"]),
        ne(matches.status, "dismissed"),
      ),
    )
    .orderBy(desc(matches.firstSeen));

  // Sort by level so BV/HIGH always score first within a run budget.
  const eligible = candidates.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level],
  );

  let scored = 0;
  let skipped = 0;
  let errored = 0;

  for (const m of eligible.slice(0, limit)) {
    if (Date.now() - start > timeBudgetMs) {
      console.warn(
        `[fit] time budget exhausted (${timeBudgetMs}ms) — bailing with ${scored} scored, ${eligible.length - scored - skipped - errored} remaining`,
      );
      break;
    }
    const sector: Sector = await sectorForSlug(m.companySlug);
    const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
    if (!rawDesc) {
      skipped++;
      console.log(`[fit] skip ${m.companySlug}/${m.jobId} — no description`);
      continue;
    }
    const desc = extractScoringText(rawDesc);
    const out = await scoreFitWithClaude({
      matchId: m.id,
      title: m.title,
      company: m.companyDisplayName,
      companySlug: m.companySlug,
      location: m.location,
      description: desc,
      sector,
      rubric,
    });
    if (out.ok) {
      try {
        await persistScore(m.id, out.fit, out.tokensIn, out.tokensOut, out.costUsd, rubric);
        scored++;
        console.log(
          `[fit] ${m.companySlug}/${m.jobId} → ${out.fit.score.toFixed(1)} ` +
            `(${out.fit.flag}, $${out.costUsd.toFixed(4)}): ${m.title}`,
        );
      } catch (err) {
        console.error(`[fit] persist failed for ${m.id}:`, err);
        errored++;
      }
    } else if (out.reason === "cap_reached" || out.reason === "missing_key") {
      console.warn(`[fit] aborting remaining scoring: ${out.reason}`);
      break;
    } else if (out.reason === "already_scored") {
      skipped++;
    } else {
      errored++;
    }
  }

  return {
    scored,
    skipped,
    errored,
    remaining: Math.max(0, eligible.length - scored - skipped - errored),
  };
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

// Persist a successful score: writes the matches.fit_* fields, updates
// the level column to the score-derived value (so digest + UI filters
// reflect the unified system), and inserts an api_usage ledger row.
export async function persistScore(
  matchId: string,
  fit: FitScore,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  _rubric: ScoringRubric = DEFAULT_RUBRIC,
): Promise<void> {
  const db = getDb();
  await db
    .update(matches)
    .set({
      fitScore: fit.score.toFixed(1),
      fitSummary: fit.summary,
      fitFlag: fit.flag,
      level: levelFromFit(fit.score, fit.flag),
      updatedAt: sql`now()`,
    })
    .where(eq(matches.id, matchId));
  await db.insert(apiUsage).values({
    matchId,
    tokensIn,
    tokensOut,
    costUsd: costUsd.toFixed(6),
    model: MODEL,
  });
}
