import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { getWorkdayBoards, workdayApiUrl } from "@/db/workday-tenants";
import { buildCompanyResult } from "../core";
import { classifyRole, htmlToText, isInScope } from "../filter";
import type {
  CompanyResult,
  RawJob,
  Target,
  WorkdayJob,
  WorkdayJobDetail,
  WorkdayResponse,
} from "../types";

// ──────────────────────────────────────────────────────────────────────
// Workday adapter — list + per-job description hydration
// ──────────────────────────────────────────────────────────────────────
// Workday's public list endpoint returns title + location + jobId but
// NOT the job description. To get a description we have to hit the
// per-job endpoint, which is bounded N+1.
//
// Strategy: list-fetch everything → location-filter (cheap) →
// title-classify (cheap) → hydrate per-job detail (location +
// description) ONLY for survivors. The hydrated description lets
// applyDescriptionShift run AND makes the role eligible for the AI
// fit-scoring tier (which fetches descriptions via lib/fit/fetch-
// description.ts on demand for unscored rows).
//
// For a typical Workday tenant the in-scope + classify-passing subset
// is small (10–40 jobs out of hundreds), so the extra per-job fetches
// are cheap enough to run hourly.
// ──────────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 20;
const MAX_PAGES = 250;
const MAX_AGE_DAYS = 21;

function parsePostedOnDays(s: string | undefined | null): number {
  if (!s) return 0;
  const l = s.toLowerCase();
  if (l.includes("today")) return 0;
  if (l.includes("yesterday")) return 1;
  const m = l.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return parseInt(m[1], 10);
  console.error(`workday: unrecognized postedOn format: "${s}"`);
  return 0;
}

async function fetchPage(url: string, offset: number): Promise<WorkdayResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appliedFacets: {},
      limit: PAGE_LIMIT,
      offset,
      searchText: "",
    }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} (offset=${offset})`);
  }
  return (await res.json()) as WorkdayResponse;
}

// Single per-job GET that returns both the resolved location list (for
// multi-location postings) AND the full HTML description. Replaces the
// prior fetchJobLocations helper. Failure modes return nulls; the
// caller falls back to the list-endpoint values.
async function fetchJobDetail(
  slug: string,
  externalPath: string,
): Promise<{ location: string | null; description: string | null }> {
  const boards = await getWorkdayBoards();
  const cfg = boards[slug];
  if (!cfg) return { location: null, description: null };
  const url = `https://${slug}.${cfg.host}.myworkdayjobs.com/wday/cxs/${slug}/${cfg.board}${externalPath}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { location: null, description: null };
    const data = (await res.json()) as WorkdayJobDetail;
    const info = data.jobPostingInfo;
    if (!info) return { location: null, description: null };
    const all = [info.location, ...(info.additionalLocations ?? [])].filter(Boolean);
    const location = all.length ? all.join(" | ") : null;
    const description = info.jobDescription ? htmlToText(info.jobDescription) : null;
    return { location, description };
  } catch (err) {
    console.error(`workday: per-job fetch failed for ${slug}${externalPath}:`, err);
    return { location: null, description: null };
  }
}

export async function scanWorkdayCompany(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult> {
  const apiUrl = await workdayApiUrl(target.slug);
  if (!apiUrl) {
    throw new Error(
      `No Workday config for slug "${target.slug}" — add a row to workday_tenants (config/workday-tenants.json + npm run ingest-config)`,
    );
  }
  const scannedAt = new Date().toISOString();

  const firstPage = await fetchPage(apiUrl, 0);
  const total = firstPage.total;
  const allJobs: WorkdayResponse["jobPostings"] = [...firstPage.jobPostings];

  const restOffsets: number[] = [];
  const lastOffset = Math.min(total, MAX_PAGES * PAGE_LIMIT);
  for (let offset = PAGE_LIMIT; offset < lastOffset; offset += PAGE_LIMIT) {
    restOffsets.push(offset);
  }
  const restPages = await Promise.all(restOffsets.map((o) => fetchPage(apiUrl, o)));
  for (const p of restPages) allJobs.push(...p.jobPostings);

  const fresh = allJobs.filter((j) => parsePostedOnDays(j.postedOn) < MAX_AGE_DAYS);
  const inScope = fresh.filter((j) => isInScope(j.locationsText ?? ""));

  // Pre-classify on title in PERMISSIVE mode — anything that passes
  // every hard-skip filter (engineering, recruiter, finserv non-GTM,
  // sub-target seniority) survives, even if no positive domain pattern
  // matches. Survivors get per-job hydration so applyDescriptionShift +
  // AI triage can see the JD. The rest (hard-skip rejects) pass through
  // unhydrated and drop out at the buildCompanyResult re-classify step
  // (which runs in the same permissive mode → same outcome).
  const candidatePaths = new Set<string>();
  for (const j of inScope) {
    const loc = j.locationsText ?? "";
    const level = classifyRole(j.title, target.sector ?? "tech", loc, vocab, true);
    if (level !== null) candidatePaths.add(j.externalPath);
  }

  const detailEntries = await Promise.all(
    [...candidatePaths].map(async (externalPath) => {
      const d = await fetchJobDetail(target.slug, externalPath);
      return [externalPath, d] as const;
    }),
  );
  const detailMap = new Map(detailEntries);

  const rawJobs: RawJob[] = inScope.map((j) => {
    const d = detailMap.get(j.externalPath);
    return {
      id: j.externalPath,
      title: j.title,
      location: d?.location ?? j.locationsText ?? "",
      description: d?.description ?? undefined,
    };
  });

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: allJobs.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
    permissive: true,
  });
}
