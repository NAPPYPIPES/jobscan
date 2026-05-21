import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { buildCompanyResult } from "../core";
import { fetchWithRetry, workableUrl } from "../fetch";
import type {
  CompanyResult,
  RawJob,
  Target,
  WorkableJob,
  WorkableResponse,
} from "../types";

// Build a location string the in-scope filter + classifier can read.
// Widget endpoint returns multiple sources of geography: a top-level
// city/state/country triple, and an optional `locations[]` array for
// multi-location postings. Concatenate the union (deduped, hidden
// entries dropped) with " | " so isInScope sees the job's full
// footprint. Remote roles include "Remote" as a hint since the
// telecommuting flag doesn't carry through the join.
function workableLocationString(job: WorkableJob): string {
  const parts: string[] = [];
  const primary = [job.city, job.state, job.country].filter(Boolean).join(", ");
  if (primary) parts.push(primary);
  for (const l of job.locations ?? []) {
    if (l.hidden) continue;
    const s = [l.city, l.region, l.country].filter(Boolean).join(", ");
    if (s && !parts.includes(s)) parts.push(s);
  }
  if (job.telecommuting) parts.push("Remote");
  return parts.join(" | ");
}

// Workable adapter — title-only signal path. The widget endpoint
// returns every published role on the board in one GET, but the
// payload doesn't include the JD text. The per-job description
// endpoint that the careers SPA uses requires auth, so we cannot
// hydrate descriptions cheaply (unlike the Workday adapter, which has
// a public per-job detail endpoint). Downstream, Tier-1 Haiku triage
// runs with title + location + company-description only — quality is
// lower than for description-bearing ATSs but still useful for the
// hourly cron.
export async function scanWorkableCompany(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult> {
  const scannedAt = new Date().toISOString();
  const res = await fetchWithRetry(workableUrl(target.slug));
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as WorkableResponse;

  const rawJobs: RawJob[] = data.jobs.map((j) => ({
    id: j.shortcode,
    title: j.title,
    location: workableLocationString(j),
  }));

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: data.jobs.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
    permissive: true,
  });
}
