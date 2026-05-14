import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, matches, roleSummaries } from "@/db/schema";
import { extractScoringText, fetchDescription } from "@/lib/fit/fetch-description";
import { getCompanyDescription, getCurrentMonthSpend } from "@/lib/fit/score";
import { CURRENT_PROMPT_VERSION, generateSummary } from "@/lib/fit/summary-prompt";
import { sectorForSlug, stageForSlug } from "@/db/targets";
import { getUserProfile } from "@/db/profile";
import { requireOwner } from "@/lib/auth/viewer";

// Claude Haiku 4.5 takes 5-15s for a generate. Vercel Hobby defaults
// to 10s for serverless functions, so the function gets killed mid-
// Claude-call without this. Matches the score / scan / digest cron
// routes which set 60s for the same reason.
export const maxDuration = 60;

const HARD_CAP_USD = 40.0;
const SOFT_CAP_USD = 35.0;
const MODEL = "claude-haiku-4-5-20251001";

// POST /api/matches/{id}/summarize           — cache-aware
// POST /api/matches/{id}/summarize?force=true — bypass cache, regenerate
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handlePost(req, params);
  } catch (err) {
    // Top-level catch so the UI sees a real JSON body and logs
    // capture the stack. Without this, an uncaught throw becomes an
    // opaque 500 with no body and the card just shows "Couldn't
    // generate analysis" without any diagnostic detail.
    console.error("[summary] route crashed:", err);
    return NextResponse.json(
      { error: "internal", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function handlePost(
  req: Request,
  params: Promise<{ id: string }>,
) {
  // Hard block: every Claude call here costs real money on the
  // owner's API key. Demo viewers must never be able to trigger one,
  // even by hitting the route directly past the disabled UI button.
  const denied = await requireOwner();
  if (denied) return denied;

  const { id } = await params;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  const db = getDb();

  const matchRows = await db
    .select()
    .from(matches)
    .where(eq(matches.id, id))
    .limit(1);
  const m = matchRows[0];
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (m.level === "LOW") {
    return NextResponse.json(
      { error: "summaries not available for LOW roles" },
      { status: 400 },
    );
  }

  // Cache check unless force=true. Only a current-version row counts
  // as a hit — stale rows fall through and regenerate.
  if (!force) {
    const existing = await db
      .select()
      .from(roleSummaries)
      .where(
        and(
          eq(roleSummaries.matchId, id),
          eq(roleSummaries.promptVersion, CURRENT_PROMPT_VERSION),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return NextResponse.json({
        summary: existing[0].summary,
        pros: existing[0].pros,
        cons: existing[0].cons,
        cached: true,
        generated_at: existing[0].generatedAt.toISOString(),
      });
    }
  }

  const spend = await getCurrentMonthSpend();
  if (spend >= HARD_CAP_USD) {
    return NextResponse.json(
      { error: "monthly cap reached, summaries paused" },
      { status: 503 },
    );
  }
  if (spend >= SOFT_CAP_USD) {
    console.warn(
      `[summary] approaching cap ($${spend.toFixed(2)} of $${HARD_CAP_USD.toFixed(2)})`,
    );
  }

  const profile = await getUserProfile();
  const background = profile?.parsedSummary ??
    "(No candidate profile has been ingested yet — run `npm run ingest-resume`.)";

  const rawDesc = await fetchDescription(m.ats, m.companySlug, m.jobId);
  const jobDescription = rawDesc ? extractScoringText(rawDesc) : null;
  const companyDescription = await getCompanyDescription(m.companySlug);
  const [stage, sector] = await Promise.all([
    stageForSlug(m.companySlug),
    sectorForSlug(m.companySlug),
  ]);

  const out = await generateSummary({
    background,
    title: m.title,
    company: m.companyDisplayName,
    companyDescription,
    location: m.location,
    stage,
    sector,
    jobDescription,
  });
  if (!out.ok) {
    const status = out.reason === "missing_key" ? 500 : 502;
    return NextResponse.json({ error: out.reason }, { status });
  }

  await db
    .insert(roleSummaries)
    .values({
      matchId: id,
      summary: out.result.summary,
      pros: out.result.pros,
      cons: out.result.cons,
      promptVersion: CURRENT_PROMPT_VERSION,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      costUsd: out.costUsd.toFixed(6),
    })
    .onConflictDoUpdate({
      target: roleSummaries.matchId,
      set: {
        summary: out.result.summary,
        pros: out.result.pros,
        cons: out.result.cons,
        generatedAt: sql`now()`,
        promptVersion: CURRENT_PROMPT_VERSION,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        costUsd: out.costUsd.toFixed(6),
      },
    });

  await db.insert(apiUsage).values({
    matchId: id,
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    costUsd: out.costUsd.toFixed(6),
    model: MODEL,
    purpose: "summary",
  });

  return NextResponse.json({
    summary: out.result.summary,
    pros: out.result.pros,
    cons: out.result.cons,
    cached: false,
    generated_at: new Date().toISOString(),
  });
}
