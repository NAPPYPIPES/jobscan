// Tier-1 Haiku triage. Runs on every new desc-capable role at scan
// time. Cheap (~$0.002/call after prompt cache is warm) so we can
// afford to run it broadly, then escalate selectively to Sonnet for
// the promising ones via lib/fit/escalation.ts.
//
// Design rationale:
//   - The resume + BV definition + scoring scale all live in the
//     SYSTEM block with cache_control={type:"ephemeral"}, so they get
//     served from Anthropic's prompt cache on every call after the
//     first. Without caching, per-call input would be ~20K tokens at
//     base Haiku rates and the cost math breaks.
//   - User message is title + location + company + first 600 chars of
//     description. That's intentionally narrow — title carries most of
//     the BV signal, and 600 chars of opening JD covers the rest.
//   - is_potential_bv is the load-bearing flag. The escalation policy
//     in escalation.ts always escalates true → Sonnet (subject to cap)
//     regardless of tier1_score. Better to pay $0.018 for Sonnet to
//     reject a Haiku false-positive than to miss a real BV match.
//   - Healthcare exclusion baked in at Tier 1 — cheaper to drop
//     healthcare roles here than escalate them to Sonnet.

import Anthropic from "@anthropic-ai/sdk";
import { getRawResume } from "@/db/profile";
import { getCompanyDescription } from "./score";
import type { Tier1Result } from "./escalation";

// Haiku 4.5 — fast, cheap, JSON-reliable. Public pricing as of 2026-05:
// $0.80/MTok input, $4.00/MTok output. Cache reads at 10% of base
// input, cache writes at 125% of base input.
const MODEL = "claude-haiku-4-5-20251001";
const INPUT_PER_MTOK = 0.80;
const OUTPUT_PER_MTOK = 4.00;
const CACHE_WRITE_PER_MTOK = 1.00;       // 125% of base = $1.00
const CACHE_READ_PER_MTOK = 0.08;        // 10% of base = $0.08

export type TriageResult =
  | {
      ok: true;
      tier1: Tier1Result;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    }
  | {
      ok: false;
      reason:
        | "missing_key"
        | "no_profile"
        | "api_error"
        | "parse_error"
        | "total_cap"
        | "triage_cap";
      error?: unknown;
    };

// Anthropic SDK message-create accepts a system block as either a
// string or an array of content blocks. The array form lets us mark
// specific blocks as cacheable via cache_control. We cache the entire
// system block (resume + BV definition + rubric + schema) as one unit
// — it's ~20K tokens and stable across every triage call.
function buildSystemBlock(resumeMd: string): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: "text",
      text: SYSTEM_PROMPT_HEADER + "\n\n" + resumeMd + "\n\n" + SYSTEM_PROMPT_FOOTER,
      cache_control: { type: "ephemeral" },
    },
  ];
}

const SYSTEM_PROMPT_HEADER = `You are the Tier-1 triage classifier for a personal job-fit pipeline. Your job is to read a single job posting and return a fast, cheap fit score plus a flag for whether the role might be a Business Value role worth verifying with a more expensive model.

You return strictly valid JSON, no other text, no markdown fences.

================================================================
CANDIDATE PROFILE (full resume — source of truth for "fit")
================================================================`;

const SYSTEM_PROMPT_FOOTER = `================================================================
WHAT "BV" MEANS FOR THIS CANDIDATE — READ CAREFULLY
================================================================
The candidate's BV (Business Value) experience is specifically 8 years at Salesforce running the Business Value Services practice for the Financial Services vertical. They built ROI frameworks, business cases, and executive narratives for F500 enterprise deals; led a team of value engineers and AE coaches; co-authored industry whitepapers; and were the primary value consulting voice for hundreds of bank and credit union pursuits.

BV scoring is RESERVED for roles whose TITLE contains explicit business-value function words AND whose SENIORITY is Director-and-above (or staff-IC equivalent at companies that use IC-track titles like "Principal" / "Staff").

Title patterns that qualify (case-insensitive):
  - "Business Value"   (e.g. "Business Value Engineer", "Head of Business Value Services")
  - "Value Consulting" (e.g. "Senior Value Consultant")
  - "Value Engineering" (e.g. "Value Engineer", "Director of Value Engineering", "Value Engineer, AI Success")
  - "Value Realization"
  - "Value Advisory"   (e.g. "Principal Value Advisor")
  - "Value Architecture" (e.g. "Value Architect")
  - "Value Services"
  - "Customer Value" + senior modifier (Lead / Principal / Director / Head / VP)

Seniority qualifiers required for BV (one must be present in the title OR inferable from the snippet):
  - Director / Sr Director / Senior Director / VP / SVP / Head of / Chief
  - OR staff-IC: Principal / Staff / Lead / Senior Principal
  - OR explicit team-management scope in the description snippet

Set is_potential_bv = true ONLY if BOTH a title pattern AND a seniority qualifier are present. When in doubt about seniority but the title clearly matches, set true — Tier 2 will verify.

Roles that are STRONG FITS but NOT BV — examples that MUST NOT be flagged as is_potential_bv:
  - VP GTM / VP Sales / VP Revenue at any company
  - Director of Enterprise Sales / Head of Strategic Sales
  - Sales Engineering / Solutions Engineering / Solutions Consulting
  - GTM Strategy / RevOps / Sales Operations leadership
  - Customer Success leadership (unless title explicitly says "Value")
  - Account Executive / AE / Sales Rep at any level
  - Partnerships / Alliances
  - Marketing / Product Marketing / GTM Marketing

These can still earn a high tier1_score (7-9) — they just aren't BV. BV is the rare "exact career-path match" tier, not the "great role" tier.

================================================================
TIER-1 SCORING SCALE (0–10)
================================================================
You only have the title, location, company description, and first 600 characters of the JD. Score holistically against the candidate's background.

  10  Exact target role at a top-fit company (rare; usually a BV role at AI-native or enterprise-fintech).
   9  Very strong fit on 4+ dimensions (function, seniority, industry, stage).
   8  Strong fit with one soft dimension.
   7  Solid fit worth surfacing — function adjacent + seniority right, OR function right + seniority slightly off.
   6  Decent overlap, multiple soft dimensions. Borderline escalation case.
   5  Visible signal but doesn't clearly fit. Adjacent function, off level.
   4  Weak fit.
   3  Stretch.
   2  Off-target.
   0–1 Clearly not relevant (wrong function entirely, or hard exclusion).

CONFIDENCE:
  high   — title + snippet give you a clear read.
  medium — title is clear but snippet is generic, OR title is ambiguous and you guessed.
  low    — title is genuinely opaque or the role type is hard to triangulate from 600 chars alone.

================================================================
HARD EXCLUSIONS
================================================================
If the role is clearly healthcare/health-tech-focused (provider, payer, biotech, medical device, healthtech): tier1_score ≤ 2, is_potential_bv = false, note "healthcare" in quick_take.

LOCATION FILTER — STRICT. The candidate is based in NYC and only
considers roles that are EITHER:
  (a) located in NYC, the NYC metro area (Westchester, Long Island,
      Northern New Jersey commute corridor, southern Connecticut), OR
  (b) fully US-remote (work-from-anywhere within the US).

EVERYTHING ELSE is a hard miss. Set tier1_score ≤ 2, is_potential_bv =
false, and note "wrong location" in quick_take. This includes:
  - Single non-NYC US cities: SF, LA, Austin, Boston, Chicago, Seattle,
    Denver, Atlanta, Dallas, Miami, DC-only, Portland, etc.
  - Hybrid roles anchored to a non-NYC office.
  - Country-specific roles outside the US: India, EMEA, APAC, LATAM,
    UK, Germany, Singapore, Japan, etc.
  - Regional sales titles outside the Northeast — even if the location
    field looks generous, the title carries the constraint:
      "Account Executive - West"           → wrong region
      "AE, Bay Area"                       → wrong region
      "Sales Director - Pacific Northwest" → wrong region
      "RVP, West"                          → wrong region
      "Account Manager, LATAM"             → wrong region
      "Strategic Sales, EMEA"              → wrong region
    Roles titled "- East", "- Northeast", "- US East" are usually
    in-scope (covers NYC). When ambiguous, lean inclusive — Tier 2
    will verify.

When the title clearly anchors a role to a non-Northeast region OR
the location field names a non-NYC US city without remote/hybrid
options, score ≤ 2 even if the function and seniority are perfect.
A great Director of Sales role in Austin is still off-thesis for this
candidate.

================================================================
OUTPUT
================================================================
Return this JSON exactly. No other text. No markdown fences.

{
  "tier1_score": <number 0.0–10.0, one decimal>,
  "confidence": "low" | "medium" | "high",
  "quick_take": "<one sentence, max 25 words>",
  "is_potential_bv": <true | false>
}`;

export async function triageRoleWithHaiku(args: {
  title: string;
  company: string;
  companySlug: string;
  location: string;
  descriptionSnippet: string;
}): Promise<TriageResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_key" };

  // Resume is required — without it Tier-1 can't score "fit" meaningfully.
  // Fresh installs without ingest-resume should not run triage; the
  // caller (lib/scan/run.ts) can fall back to the keyword classifier.
  const resumeMd = await getRawResume();
  if (!resumeMd) return { ok: false, reason: "no_profile" };

  const client = new Anthropic({ apiKey });

  // Truncate description to 600 chars at a word boundary if possible —
  // mid-word cutoffs occasionally confuse models. Falls back to hard
  // cut if no whitespace within the budget.
  const snippet = truncateAtWord(args.descriptionSnippet, 600);

  const companyDescription = await getCompanyDescription(args.companySlug);

  const userMessage = [
    `Title: ${args.title}`,
    `Company: ${args.company}`,
    `Company description: ${companyDescription ?? "(unknown — score from title and snippet only)"}`,
    `Location: ${args.location}`,
    ``,
    `Description (first 600 chars):`,
    snippet,
  ].join("\n");

  try {
    const response = await callHaikuWithRetry(client, resumeMd, userMessage);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const tier1 = parseTriageJson(text);
    if (!tier1) {
      // Already retried once inside callHaikuWithRetry; this is the
      // terminal parse failure path. Caller falls back to the keyword
      // classifier per the cap-fallback policy.
      console.error(
        `[triage] parse failed after retry for ${args.companySlug}/${args.title}: ${text.slice(0, 200)}`,
      );
      return { ok: false, reason: "parse_error" };
    }

    const usage = response.usage;
    const tokensIn = usage.input_tokens ?? 0;
    const tokensOut = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    // Cost includes: variable input at base rate + cached reads at 10%
    // + cache writes at 125% + output at base rate. Anthropic's input_
    // tokens already excludes cache_read and cache_creation tokens, so
    // they sum cleanly.
    const costUsd =
      (tokensIn / 1_000_000) * INPUT_PER_MTOK +
      (cacheReadTokens / 1_000_000) * CACHE_READ_PER_MTOK +
      (cacheWriteTokens / 1_000_000) * CACHE_WRITE_PER_MTOK +
      (tokensOut / 1_000_000) * OUTPUT_PER_MTOK;

    return {
      ok: true,
      tier1,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
    };
  } catch (err) {
    console.error(`[triage] API error for ${args.companySlug}/${args.title}:`, err);
    return { ok: false, reason: "api_error", error: err };
  }
}

// One retry on parse failure with a stricter system suffix. If both
// attempts fail to parse, return the second response and let the
// caller log + fall back. The retry is rare in practice — Haiku's JSON
// adherence is >99% — but it's cheap insurance against intermittent
// glitches.
async function callHaikuWithRetry(
  client: Anthropic,
  resumeMd: string,
  userMessage: string,
): Promise<Anthropic.Messages.Message> {
  const system = buildSystemBlock(resumeMd);

  const first = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  const firstText = textFromResponse(first);
  if (parseTriageJson(firstText)) return first;

  console.warn(`[triage] first response not valid JSON, retrying once`);
  const second = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system,
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: firstText },
      {
        role: "user",
        content:
          "Your previous response was not valid JSON. Return ONLY the JSON object, no other text and no markdown fences.",
      },
    ],
  });
  return second;
}

function textFromResponse(r: Anthropic.Messages.Message): string {
  return r.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > max - 50) return cut.slice(0, lastSpace) + "…";
  return cut + "…";
}

// Parse Haiku's JSON response. Tolerates wrapping ```json fences even
// though the system prompt asks for raw JSON. Returns null on any
// shape mismatch so the caller can decide whether to retry or fall
// back to the keyword classifier.
function parseTriageJson(text: string): Tier1Result | null {
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
  const score = typeof p.tier1_score === "number" && Number.isFinite(p.tier1_score)
    ? p.tier1_score
    : null;
  const confidence = p.confidence;
  const quickTake = typeof p.quick_take === "string" ? p.quick_take : null;
  const isPotentialBv = typeof p.is_potential_bv === "boolean" ? p.is_potential_bv : null;
  if (
    score == null ||
    quickTake == null ||
    isPotentialBv == null ||
    typeof confidence !== "string" ||
    !["low", "medium", "high"].includes(confidence)
  ) {
    return null;
  }
  // Clamp to [0, 10] in case the model goes outside the scale.
  const clamped = Math.max(0, Math.min(10, score));
  return {
    tier1_score: clamped,
    confidence: confidence as "low" | "medium" | "high",
    quick_take: quickTake,
    is_potential_bv: isPotentialBv,
  };
}
