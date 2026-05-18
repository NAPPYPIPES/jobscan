// Resume parsing pulled out of scripts/ingest-resume.ts so both the CLI
// (maintainer's npm run ingest-resume) and the onboarding API (new
// users pasting markdown in the browser) call the same Haiku prompt.
// Cost is ~$0.01 per call; takes 5-15s; runs synchronously on
// onboarding so the next step sees a fully-populated user_profile.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001";
const INPUT_PER_MTOK = 1.0;
const OUTPUT_PER_MTOK = 5.0;

const SYSTEM_PROMPT = `You extract a candidate's resume into a structured JSON profile that downstream job-scoring prompts will read on every API call.

Output exactly this JSON shape, no other text:
{
  "parsed_summary": "<250-350 words>",
  "years_experience": <integer or null>,
  "industries": ["<industry>", ...],
  "functions": ["<function>", ...],
  "seniority_level": "<one short phrase like 'VP/Director' or 'Senior IC' or null>",
  "target_roles": ["<role>", ...],
  "hard_exclusions": ["<exclusion>", ...]
}

Rules:
- parsed_summary: 250-350 words. Write as if it were a candidate brief Claude will re-read at the top of every scoring call. Name the strongest 2-3 industry/function combos, the seniority bands the candidate is qualified for, what they explicitly do NOT want. Be concrete — name specific companies, dollar amounts, product categories from their resume. No fluff.
- years_experience: total professional years, integer. Null if unstated.
- industries: 2-6 specific industries the candidate has worked in (e.g. "Enterprise SaaS", "Financial Services", "Healthcare AI"). Not generic ("Technology").
- functions: 2-5 functional areas the candidate has performed (e.g. "Sales leadership", "GTM strategy", "Business Value Consulting"). Not generic ("Management").
- seniority_level: one phrase describing the candidate's current tier ("VP/Director", "C-suite", "Senior IC", etc.). Null if unstated.
- target_roles: 3-8 specific role titles the candidate is targeting next. Pull from a "Target Roles" or "Looking For" section if present; otherwise infer from their trajectory.
- hard_exclusions: things the candidate has explicitly said they do NOT want — industry verticals, role types, geographic constraints. Empty array if the resume names no exclusions.`;

export type ParsedResume = {
  parsedSummary: string;
  yearsExperience: number | null;
  industries: string[];
  functions: string[];
  seniorityLevel: string | null;
  targetRoles: string[];
  hardExclusions: string[];
};

export type ParseResumeResult = {
  parsed: ParsedResume;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

function parseResponse(text: string): ParsedResume | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  const intOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((s) => s.trim())
      : [];

  const parsedSummary = str(p.parsed_summary);
  if (!parsedSummary) return null;

  return {
    parsedSummary,
    yearsExperience: intOrNull(p.years_experience),
    industries: strArr(p.industries),
    functions: strArr(p.functions),
    seniorityLevel: str(p.seniority_level),
    targetRoles: strArr(p.target_roles),
    hardExclusions: strArr(p.hard_exclusions),
  };
}

// Parses raw resume markdown into structured fields via one Haiku call.
// Throws on missing API key, network failure, or unparseable response.
export async function parseResumeWithClaude(
  rawResumeMd: string,
): Promise<ParseResumeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.1,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Resume to parse:\n\n${rawResumeMd}` }],
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

  const parsed = parseResponse(text);
  if (!parsed) {
    throw new Error(`Claude returned an unparseable response: ${text.slice(0, 500)}`);
  }

  return { parsed, tokensIn, tokensOut, costUsd };
}

export const RESUME_PARSE_MODEL = MODEL;
