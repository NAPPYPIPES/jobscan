// Parses docs/resume.md into the user_profile table via one Claude
// Haiku call. Overwrites any existing profile row — there's only ever
// one. Cost: ~$0.01 per run. Re-run any time you update the resume.
//
// Usage:
//   npm run ingest-resume
//
// Prerequisites:
//   - docs/resume.md exists (see docs/resume.example.md for the
//     recommended structure)
//   - .env.local has ANTHROPIC_API_KEY and DATABASE_URL set
//   - The user_profile table exists (run `npx drizzle-kit push` first)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { replaceUserProfile } from "../db/profile";

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

function parseResponse(text: string): {
  parsedSummary: string;
  yearsExperience: number | null;
  industries: string[];
  functions: string[];
  seniorityLevel: string | null;
  targetRoles: string[];
  hardExclusions: string[];
} | null {
  // Strip markdown fences if Haiku wraps the JSON.
  let body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
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
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
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

async function main() {
  const resumePath = path.join(process.cwd(), "docs", "resume.md");

  let resumeMd: string;
  try {
    resumeMd = await fs.readFile(resumePath, "utf8");
  } catch {
    console.error(
      `\nCouldn't read ${resumePath}.\n\n` +
        `Create it first — see docs/resume.example.md for the recommended\n` +
        `structure. The resume.md file is gitignored so it won't be committed.\n`,
    );
    process.exit(1);
  }

  if (resumeMd.trim().length < 200) {
    console.error(
      `\ndocs/resume.md is only ${resumeMd.trim().length} characters — probably\n` +
        `empty or just a stub. Fill it in and re-run.\n`,
    );
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set in .env.local");
    process.exit(1);
  }

  console.log(
    `Parsing resume (${resumeMd.length} chars) via ${MODEL}…`,
  );

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0.1,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Resume to parse:\n\n${resumeMd}`,
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

  const parsed = parseResponse(text);
  if (!parsed) {
    console.error(`\nClaude returned an unparseable response:\n${text.slice(0, 500)}\n`);
    process.exit(1);
  }

  const saved = await replaceUserProfile({
    rawResumeMd: resumeMd,
    parsedSummary: parsed.parsedSummary,
    yearsExperience: parsed.yearsExperience,
    industries: parsed.industries,
    functions: parsed.functions,
    seniorityLevel: parsed.seniorityLevel,
    targetRoles: parsed.targetRoles,
    hardExclusions: parsed.hardExclusions,
  });

  console.log(`\n─── Parsed profile ───`);
  console.log(`Years of experience: ${parsed.yearsExperience ?? "(unstated)"}`);
  console.log(`Seniority level:     ${parsed.seniorityLevel ?? "(unstated)"}`);
  console.log(`Industries:          ${parsed.industries.join(", ") || "(none)"}`);
  console.log(`Functions:           ${parsed.functions.join(", ") || "(none)"}`);
  console.log(`Target roles:        ${parsed.targetRoles.join(", ") || "(none)"}`);
  console.log(`Hard exclusions:     ${parsed.hardExclusions.join(", ") || "(none)"}`);
  console.log(`\nSummary (used in every scoring prompt):`);
  console.log(parsed.parsedSummary);
  console.log(`\nCost: $${costUsd.toFixed(4)} (${tokensIn} in / ${tokensOut} out)`);
  console.log(`────────────────────────\n`);
  console.log(`Saved to user_profile (id: ${saved.id}).`);
  console.log(`Re-run any time you update docs/resume.md.`);
}

main().catch((err) => {
  console.error("ingest-resume failed:", err);
  process.exit(1);
});
