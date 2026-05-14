import Anthropic from "@anthropic-ai/sdk";

// Claude Haiku 4.5 — cheap, fast, and the task is structured-JSON
// output where Sonnet's reasoning depth isn't needed.
const MODEL = "claude-haiku-4-5-20251001";
const INPUT_PER_MTOK = 1.0;
const OUTPUT_PER_MTOK = 5.0;

// Bumping this invalidates every cached summary on next click.
// Increment after a meaningful prompt change so old summaries
// auto-regenerate without a manual purge. Cache-hit query in the
// /summarize route filters on (matchId, promptVersion) — a row at a
// lower version looks like a miss and triggers a fresh generate.
export const CURRENT_PROMPT_VERSION = 1;

const SYSTEM_PROMPT = `You analyze specific job opportunities for a candidate and provide candid, direct assessments. You are not a cheerleader. Honest cons are as important as accurate pros. Be specific — reference concrete details from the candidate's background and the role. Avoid generic praise.

Return only valid JSON in the exact format requested.`;

export type SummaryResult = {
  summary: string;
  pros: string[];
  cons: string[];
};

export type SummaryCallResult =
  | {
      ok: true;
      result: SummaryResult;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    }
  | {
      ok: false;
      reason: "missing_key" | "api_error" | "parse_error";
      error?: unknown;
    };

// One Claude call → JSON → parse → return. One retry on parse failure
// because Haiku occasionally wraps the JSON in a ```json fence or
// appends a stray sentence despite the system prompt forbidding it.
// No retry on API error — caller decides what to do.
export async function generateSummary(args: {
  background: string;
  title: string;
  company: string;
  companyDescription: string | null;
  location: string;
  stage: string | null;
  sector: string;
  jobDescription: string | null;
}): Promise<SummaryCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_key" };

  const client = new Anthropic({ apiKey });
  const userMessage = buildUserMessage(args);

  let lastParseText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (err) {
      console.error(`[summary] API error (attempt ${attempt + 1}):`, err);
      if (attempt === 1) return { ok: false, reason: "api_error", error: err };
      continue;
    }

    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const costUsd =
      (tokensIn / 1_000_000) * INPUT_PER_MTOK +
      (tokensOut / 1_000_000) * OUTPUT_PER_MTOK;
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseSummaryJson(text);
    if (parsed) {
      return { ok: true, result: parsed, tokensIn, tokensOut, costUsd };
    }
    lastParseText = text;
    console.warn(
      `[summary] parse failed (attempt ${attempt + 1}): ${text.slice(0, 200)}`,
    );
  }

  console.error(`[summary] giving up after retry; last response: ${lastParseText.slice(0, 300)}`);
  return { ok: false, reason: "parse_error" };
}

function buildUserMessage(args: {
  background: string;
  title: string;
  company: string;
  companyDescription: string | null;
  location: string;
  stage: string | null;
  sector: string;
  jobDescription: string | null;
}): string {
  return `CANDIDATE BACKGROUND:
${args.background}

ROLE TO EVALUATE:
Title: ${args.title}
Company: ${args.company}
Company description: ${args.companyDescription ?? "(unknown)"}
Location: ${args.location}
Stage: ${args.stage ?? "(unknown)"}
Sector: ${args.sector}

Job description:
${args.jobDescription ?? "(not available — assess from title and company info only)"}

Generate three sections:

1. summary: 2 sentences max, 50 words total. What is this role actually about beyond what the title conveys? Include context like team size, sales motion, target buyer, or growth stage if discernible. Don't restate the title.

2. pros: 2-3 short bullet points. Fragments OK. Specific reasons the candidate is a strong fit for THIS particular role. Reference their background concretely — name companies, functions, industries that align. Avoid generic praise like "strong communicator."

3. cons: 2-3 short bullet points. Fragments OK. Honest reasons the candidate might NOT be the best fit. Specific concerns: experience gaps, level mismatches, comp band concerns, industry adjacency stretches, culture risks, geographic constraints. Be direct — soft-pedaling makes this useless.

Return JSON only, no other text:
{
  "summary": "...",
  "pros": ["...", "...", "..."],
  "cons": ["...", "...", "..."]
}`;
}

function parseSummaryJson(text: string): SummaryResult | null {
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
  const summary = typeof p.summary === "string" ? p.summary.trim() : null;
  const pros = Array.isArray(p.pros)
    ? p.pros.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : null;
  const cons = Array.isArray(p.cons)
    ? p.cons.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : null;
  if (!summary || !pros || !cons) return null;
  if (pros.length === 0 || cons.length === 0) return null;
  return { summary, pros, cons };
}
