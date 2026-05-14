import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { buildCompanyResult } from "../core";
import { ashbyUrl, fetchWithRetry } from "../fetch";
import type { AshbyJob, AshbyResponse, CompanyResult, Target } from "../types";

// Ashby jobs can list a primary location plus several
// secondaryLocations. Join with " | " so isInScope sees a job's full
// geographic footprint — otherwise a London-primary job that also
// posts to NYC would be missed.
function ashbyLocationString(job: AshbyJob): string {
  const all = [job.location, ...(job.secondaryLocations ?? []).map((l) => l.location)];
  return all.filter(Boolean).join(" | ");
}

export async function scanAshbyCompany(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult> {
  const scannedAt = new Date().toISOString();
  const res = await fetchWithRetry(ashbyUrl(target.slug));
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as AshbyResponse;

  const listed = data.jobs.filter((j) => j.isListed);
  const rawJobs = listed.map((j) => ({
    id: j.id,
    title: j.title,
    location: ashbyLocationString(j),
    description: j.descriptionPlain?.toLowerCase(),
  }));

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: listed.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
  });
}
