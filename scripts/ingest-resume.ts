// Parses docs/resume.md into the user_profile table via one Claude
// Haiku call. Overwrites any existing profile row — there's only ever
// one per user (the maintainer for this CLI). Cost: ~$0.01 per run.
// Re-run any time you update the resume.
//
// Usage:
//   npm run ingest-resume
//
// Prerequisites:
//   - docs/resume.md exists (see docs/resume.example.md for the
//     recommended structure)
//   - .env.local has ANTHROPIC_API_KEY and DATABASE_URL set
//   - migrations 0001-0004 have been applied

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { replaceUserProfile } from "../db/profile";
import { MAINTAINER_USER_ID } from "../lib/auth/maintainer";
import { parseResumeWithClaude, RESUME_PARSE_MODEL } from "../lib/profile/parse-resume";

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

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in .env.local");
    process.exit(1);
  }

  console.log(`Parsing resume (${resumeMd.length} chars) via ${RESUME_PARSE_MODEL}…`);

  const { parsed, tokensIn, tokensOut, costUsd } = await parseResumeWithClaude(resumeMd);

  // CLI = maintainer. New users edit their resume via the
  // onboarding wizard which calls replaceUserProfile with the
  // signed-in user's id.
  const saved = await replaceUserProfile(MAINTAINER_USER_ID, {
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
