// POST /api/onboarding/resume
// Body: { rawResumeMd: string }
//
// Step 1 of the onboarding wizard. Parses the pasted markdown into the
// structured user_profile row via one Haiku call. Blocks for 5-15s —
// the wizard shows a "Parsing…" spinner. Logs the cost into api_usage
// for the user so it counts against their monthly cap.

import { NextResponse } from "next/server";
import { getViewerUserId } from "@/lib/auth/viewer";
import { replaceUserProfile } from "@/db/profile";
import { parseResumeWithClaude, RESUME_PARSE_MODEL } from "@/lib/profile/parse-resume";
import { getDb } from "@/db/client";
import { apiUsage } from "@/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const MIN_RESUME_CHARS = 200;

export async function POST(req: Request) {
  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { rawResumeMd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawResumeMd = typeof body.rawResumeMd === "string" ? body.rawResumeMd.trim() : "";
  if (rawResumeMd.length < MIN_RESUME_CHARS) {
    return NextResponse.json(
      { error: `Resume must be at least ${MIN_RESUME_CHARS} characters.` },
      { status: 400 },
    );
  }

  let parseOut: Awaited<ReturnType<typeof parseResumeWithClaude>>;
  try {
    parseOut = await parseResumeWithClaude(rawResumeMd);
  } catch (err) {
    console.error("[onboarding/resume] parse failed", err);
    return NextResponse.json(
      { error: "Resume parsing failed. Try again, or contact support if it persists." },
      { status: 502 },
    );
  }

  await replaceUserProfile(userId, {
    rawResumeMd,
    parsedSummary: parseOut.parsed.parsedSummary,
    yearsExperience: parseOut.parsed.yearsExperience,
    industries: parseOut.parsed.industries,
    functions: parseOut.parsed.functions,
    seniorityLevel: parseOut.parsed.seniorityLevel,
    targetRoles: parseOut.parsed.targetRoles,
    hardExclusions: parseOut.parsed.hardExclusions,
  });

  // Charge the parse cost against the user's monthly cap.
  const db = getDb();
  await db.insert(apiUsage).values({
    userId,
    matchId: null,
    tokensIn: parseOut.tokensIn,
    tokensOut: parseOut.tokensOut,
    costUsd: parseOut.costUsd.toFixed(6),
    model: RESUME_PARSE_MODEL,
    purpose: "resume_parse",
  });

  return NextResponse.json({ ok: true });
}
