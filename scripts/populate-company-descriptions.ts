// Generates one-sentence company descriptions for every TARGET via
// Claude Haiku and writes them to the companies table. The scoring
// path reads these descriptions on every call so Claude has accurate
// context about what each company actually sells and to whom.
//
// Default: dry run — prints every description without touching the
// DB. Pass --write to persist.
//
// Usage:
//   npm run populate-companies          # dry run
//   npm run populate-companies -- --write
//   npm run populate-companies -- --only=anthropic,stripe
//
// Cost: ~$0.002/call × 20 targets ≈ $0.04 for a full pass.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { companies } from "../db/schema";
import { getTargets } from "../db/targets";

const MODEL = "claude-haiku-4-5-20251001";
const SYSTEM_PROMPT =
  "You write one-sentence company descriptions for a job-search tool. " +
  "Be specific: industry vertical, customer type (enterprise B2B vs " +
  "consumer B2C vs developer/technical buyer), product category, and " +
  "stage if known (e.g. 'public', 'Series E', 'Series B AI-native'). " +
  "Output exactly one sentence. No quotes, no prefix like 'Description:', " +
  "no markdown.";

async function generate(client: Anthropic, displayName: string): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Company: ${displayName}\n\nWrite ONE sentence describing what ${displayName} does and who they sell to.`,
      },
    ],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^"+|"+$/g, "");
}

async function main() {
  const writeFlag = process.argv.includes("--write");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlySlugs = onlyArg
    ? new Set(
        onlyArg.replace(/^--only=/, "").split(",").map((s) => s.trim()).filter(Boolean),
      )
    : null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  const allTargets = await getTargets();
  if (allTargets.length === 0) {
    console.error(
      "targets table is empty — run `npm run ingest-config` to seed it first.",
    );
    process.exit(1);
  }
  const targets = onlySlugs
    ? allTargets.filter((t) => onlySlugs.has(t.slug))
    : allTargets;
  if (onlySlugs && targets.length === 0) {
    console.error(`--only matched 0 targets. Slugs requested: ${[...onlySlugs].join(", ")}`);
    process.exit(1);
  }

  console.log(
    `Generating descriptions for ${targets.length} targets${onlySlugs ? ` (--only)` : ""} (${writeFlag ? "WRITE MODE" : "preview only"})\n`,
  );

  const results: { slug: string; displayName: string; description: string }[] = [];
  for (const t of targets) {
    const description = await generate(client, t.displayName);
    results.push({ slug: t.slug, displayName: t.displayName, description });
    console.log(`${t.slug.padEnd(20)} ${description}`);
  }

  console.log(`\n${results.length} descriptions generated.`);

  if (writeFlag) {
    const db = getDb();
    for (const r of results) {
      await db
        .insert(companies)
        .values({
          slug: r.slug,
          displayName: r.displayName,
          description: r.description,
        })
        .onConflictDoUpdate({
          target: companies.slug,
          set: {
            displayName: r.displayName,
            description: r.description,
            updatedAt: sql`now()`,
          },
        });
    }
    console.log(`Persisted ${results.length} rows to companies table.`);
  } else {
    console.log(
      "Dry run only. Re-run with --write to persist after reviewing the output above.",
    );
  }
}

main().catch((err) => {
  console.error("populate failed:", err);
  process.exit(1);
});
