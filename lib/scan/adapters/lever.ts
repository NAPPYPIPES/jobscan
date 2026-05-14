import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { buildCompanyResult } from "../core";
import { fetchWithRetry, leverUrl } from "../fetch";
import type { CompanyResult, LeverJob, LeverResponse, Target } from "../types";

function leverLocationString(job: LeverJob): string {
  const all = job.categories.allLocations ?? [];
  const primary = job.categories.location;
  const merged = primary && !all.includes(primary) ? [primary, ...all] : all;
  return merged.filter(Boolean).join(" | ");
}

export async function scanLeverCompany(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult> {
  const scannedAt = new Date().toISOString();
  const res = await fetchWithRetry(leverUrl(target.slug));
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as LeverResponse;

  const rawJobs = data.map((j) => ({
    id: j.id,
    title: j.text,
    location: leverLocationString(j),
    description: j.descriptionPlain?.toLowerCase(),
  }));

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: data.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
  });
}
