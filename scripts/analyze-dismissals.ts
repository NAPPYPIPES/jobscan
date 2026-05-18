// One-off diagnostic: pull recent dismissals + their JDs and feed
// everything to Sonnet to look for patterns the scoring rubric is
// missing. Writes a markdown report to stdout — read it, then decide
// what (if anything) to change in lib/fit/rubric.ts or the Sonnet
// system prompt in lib/fit/score.ts.
//
// Not added to package.json — run with `npx tsx scripts/analyze-dismissals.ts`.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { fetchDescription, extractScoringText } from "../lib/fit/fetch-description";
import { DEFAULT_RUBRIC, formatRubricForPrompt } from "../lib/fit/rubric";

const MODEL = "claude-sonnet-4-6";

type DismissalRow = {
  match_id: string;
  ats: "greenhouse" | "ashby" | "lever" | "workday";
  company_slug: string;
  company_display_name: string;
  job_id: string;
  title: string;
  location: string;
  level: string;
  fit_score: string | null;
  fit_flag: string | null;
  fit_summary: string | null;
  tier1_score: string | null;
  tier1_quick_take: string | null;
  dismiss_reason: string[] | null;
  dismissed_at: Date;
};

type Enriched = DismissalRow & { jd: string | null };

const MAX_DISMISSALS = 60;       // last N dismissals to analyze
const JD_CHAR_CAP = 1800;        // per-role JD trim before sending to Sonnet
const FETCH_CONCURRENCY = 5;

async function pMap<T, R>(
  items: T[],
  fn: (item: T, i: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const maintEmail = process.env.MAINTAINER_EMAIL;
  if (!maintEmail) throw new Error("MAINTAINER_EMAIL not set");

  const sql = neon(url);

  const userRow = await sql`SELECT id FROM users WHERE email = ${maintEmail} LIMIT 1`;
  if (!userRow[0]) throw new Error(`No user found for ${maintEmail}`);
  const userId = userRow[0].id as string;
  console.error(`user: ${maintEmail} (${userId.slice(0, 8)})`);

  // Exclude the 'auto_reclassified' tag — those were a one-time bulk
  // SQL cleanup, not user-curated dismissals. We want only rows the user
  // actually clicked dismiss on (either with a reason picker tag, or
  // dismissed with no tag).
  console.error(`\nFetching last ${MAX_DISMISSALS} user-curated dismissals (excluding auto_reclassified)...`);
  const rows = (await sql`
    SELECT
      m.id AS match_id,
      m.ats,
      m.company_slug,
      m.company_display_name,
      m.job_id,
      m.title,
      m.location,
      um.level,
      um.fit_score,
      um.fit_flag,
      um.fit_summary,
      um.tier1_score,
      um.tier1_quick_take,
      um.dismiss_reason,
      um.dismissed_at
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.status = 'dismissed'
      AND um.dismissed_at IS NOT NULL
      AND (
        um.dismiss_reason IS NULL
        OR NOT (um.dismiss_reason @> ARRAY['auto_reclassified']::text[])
      )
    ORDER BY um.dismissed_at DESC
    LIMIT ${MAX_DISMISSALS}
  `) as unknown as DismissalRow[];

  console.error(`Got ${rows.length} dismissals. Fetching JDs (concurrency=${FETCH_CONCURRENCY})...`);

  const enriched: Enriched[] = await pMap(
    rows,
    async (r): Promise<Enriched> => {
      try {
        const raw = await fetchDescription(r.ats, r.company_slug, r.job_id);
        if (!raw) return { ...r, jd: null };
        const extracted = extractScoringText(raw);
        const trimmed = extracted.length > JD_CHAR_CAP
          ? extracted.slice(0, JD_CHAR_CAP) + "…"
          : extracted;
        return { ...r, jd: trimmed };
      } catch (err) {
        console.error(`  fetch failed for ${r.company_slug}/${r.job_id}: ${String(err).slice(0, 100)}`);
        return { ...r, jd: null };
      }
    },
    FETCH_CONCURRENCY,
  );

  const withJd = enriched.filter((e) => e.jd && e.jd.length > 200);
  console.error(`${withJd.length}/${enriched.length} dismissals have usable JD text.\n`);

  const reasonCounts: Record<string, number> = { no_tag: 0 };
  for (const e of enriched) {
    if (!e.dismiss_reason || e.dismiss_reason.length === 0) {
      reasonCounts.no_tag = (reasonCounts.no_tag ?? 0) + 1;
    } else {
      for (const r of e.dismiss_reason) {
        reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
      }
    }
  }
  console.error("Dismiss-reason breakdown:");
  for (const [k, v] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${k.padEnd(18)} ${v}`);
  }

  const dataBlock = withJd
    .map((e, i) => {
      const reasons = e.dismiss_reason?.length ? e.dismiss_reason.join(", ") : "(no tag)";
      const score = e.fit_score ?? "(not Sonnet-scored)";
      const tier1 = e.tier1_score ?? "—";
      const flag = e.fit_flag ?? "—";
      const sum = e.fit_summary ?? e.tier1_quick_take ?? "(none)";
      return [
        `### ${i + 1}. ${e.company_display_name} — ${e.title}`,
        `Location: ${e.location || "(none)"}`,
        `Level: ${e.level}  |  Sonnet fit_score: ${score}  |  flag: ${flag}  |  tier1: ${tier1}`,
        `Model summary: ${sum}`,
        `Dismiss reasons: ${reasons}`,
        ``,
        `JD excerpt:`,
        e.jd,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const rubricText = formatRubricForPrompt(DEFAULT_RUBRIC);

  const systemPrompt = `You are auditing a personal job-fit scoring pipeline. The user just dismissed ${withJd.length} roles that the pipeline surfaced. Your job is to look at the title + JD + the model's score and summary + the dismiss-reason tags, and identify CONCRETE patterns where the rubric or prompt is misaligned with the user's true preferences.

You will return a structured markdown report. No preamble. No "happy to help" — go straight to findings.

The user's seniority is 15+ years in GTM / Sales / Value Engineering, prior role was Sr. Director, Business Value Services at Salesforce (FinServ vertical). They target: Director-and-above Sales / Revenue / GTM leadership, Business Value / Value Engineering / Value Consulting at Director or staff-IC level at top AI / SaaS / fintech companies. NYC / NYC-metro / US-remote only.

Here is the current scoring rubric the pipeline applies:

${rubricText}

Key prompt rules in effect:
- function dimension weighted 65%, seniority 15%, industry 10%, stage 5%, location 5%
- BV is reserved for explicit value-titled roles at Director+ or staff-IC at top AI/SaaS companies
- ic_role flag is SOFT — Sonnet can elevate strong-fit IC AE roles at tier-1 AI companies to HIGH
- partnerships_specialist flag is SOFT — same logic
- relocation_required forces level=LOW + composite=0 for non-NYC / non-remote
- level_mismatch forces LOW for Analyst / Rep / Coordinator / Associate / Junior / Specialist (without leadership modifier)
- alertThreshold = 7.5 (digest includes scored roles ≥ 7.5)

Your output MUST follow this structure exactly:

## Patterns identified
For each pattern, write:
- **Pattern name** (e.g. "Sales Engineering roles surfacing as MEDIUM/HIGH despite being IC technical work")
  - Example dismissals (3-6 numbered references like "#4, #12, #18")
  - Why the rubric/prompt produced these
  - What's actually wrong from the user's perspective (read the JDs carefully)

## False positives the rubric is missing
List specific role-types or signals that should have driven a lower score but didn't. For each, name the dimension or flag that should have caught it.

## Proposed rubric edits
Use diff-style edits citing the file path and what changes:
- \`lib/fit/rubric.ts\`: e.g. "Lower function-anchor 7 for Sales Engineering by 1 point" with the rationale
- \`lib/fit/score.ts\` system prompt: e.g. "Add a new flag for X" or "Tighten the IC role elevation rule by requiring..."

Be concrete. Don't say "be more strict about X" — say "add the phrase 'Sales Engineering / Solutions Engineering / Solutions Consulting' to the level_mismatch flag rules" or similar. Each proposed edit should be reproducible by a developer with just your description.

## Proposed prompt additions
If the rubric is fine but the prompt needs tightening, propose specific paragraphs to add or replace.

## What the rubric is doing RIGHT
List 2-3 things the dismissal pattern suggests the rubric handles well, so we don't accidentally break them when fixing other things.

Focus on signal over noise. If a category only has 1-2 instances, don't make a rubric change for it — note it as "watch list".`;

  const userMessage = `Here are the ${withJd.length} dismissals to analyze:

${dataBlock}

Produce the report now.`;

  console.error(`\nCalling Sonnet (model: ${MODEL})...`);
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;
  const cost = (tokensIn / 1_000_000) * 3.0 + (tokensOut / 1_000_000) * 15.0;
  console.error(`Done. tokens_in=${tokensIn} tokens_out=${tokensOut} cost=$${cost.toFixed(4)}\n`);
  console.error("=".repeat(70));

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log(text);
}

main().catch((e) => { console.error(e); process.exit(1); });
