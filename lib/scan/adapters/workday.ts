import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { getWorkdayBoards, workdayApiUrl } from "@/db/workday-tenants";
import { buildCompanyResult } from "../core";
import type {
  CompanyResult,
  Target,
  WorkdayJob,
  WorkdayJobDetail,
  WorkdayResponse,
} from "../types";

// ──────────────────────────────────────────────────────────────────────
// IMPORTANT — Workday limitation
// ──────────────────────────────────────────────────────────────────────
// Workday's public list endpoint returns title + location + jobId but
// NOT the job description. The classifier still runs against the title
// (so Workday roles surface in scan results and the daily digest if
// the title classifies BV/HIGH), but the description-shift pass and
// the Claude fit-scoring pass both skip Workday roles. Workday roles
// in the UI will show a level badge but no fit score.
//
// For deeper Workday integration you'd need per-job description
// fetches — typically via Apify or a headless browser. Not included
// here. As a workaround for any Workday tenant you really care about,
// add it to manual-companies.json so it shows up on /manual instead.
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

async function fetchJobLocations(
  slug: string,
  externalPath: string,
): Promise<string | null> {
  const boards = await getWorkdayBoards();
  const cfg = boards[slug];
  if (!cfg) return null;
  const url = `https://${slug}.${cfg.host}.myworkdayjobs.com/wday/cxs/${slug}/${cfg.board}${externalPath}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as WorkdayJobDetail;
    const info = data.jobPostingInfo;
    if (!info) return null;
    const all = [info.location, ...(info.additionalLocations ?? [])].filter(Boolean);
    return all.length ? all.join(" | ") : null;
  } catch (err) {
    console.error(`workday: per-job fetch failed for ${slug}${externalPath}:`, err);
    return null;
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

  const MULTI_LOC = /^\d+\s+locations$/i;
  const needsHydration: WorkdayJob[] = [];
  const passThrough: WorkdayJob[] = [];
  for (const j of fresh) {
    if (MULTI_LOC.test((j.locationsText ?? "").trim())) needsHydration.push(j);
    else passThrough.push(j);
  }
  const hydrated = await Promise.all(
    needsHydration.map(async (j) => {
      const resolved = await fetchJobLocations(target.slug, j.externalPath);
      return { ...j, locationsText: resolved ?? j.locationsText };
    }),
  );

  const rawJobs = [...passThrough, ...hydrated].map((j) => ({
    id: j.externalPath,
    title: j.title,
    location: j.locationsText ?? "",
  }));

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: allJobs.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
  });
}
