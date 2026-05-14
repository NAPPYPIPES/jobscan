import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import { buildCompanyResult } from "../core";
import { fetchWithRetry, greenhouseUrl } from "../fetch";
import { htmlToText } from "../filter";
import type { CompanyResult, GreenhouseResponse, Target } from "../types";

export async function scanGreenhouseCompany(
  target: Target,
  priorIds: Set<string> | undefined,
  isBaseline: boolean,
  vocab: LoadedPersonalKeywords,
): Promise<CompanyResult> {
  const scannedAt = new Date().toISOString();
  const res = await fetchWithRetry(greenhouseUrl(target.slug));
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as GreenhouseResponse;

  // Greenhouse returns content with double-encoded HTML entities —
  // htmlToText decodes + strips tags + lowercases + collapses
  // whitespace in one pass.
  const rawJobs = data.jobs.map((j) => ({
    id: String(j.id),
    title: j.title,
    location: j.location.name,
    description: j.content ? htmlToText(j.content) : undefined,
  }));

  return buildCompanyResult({
    target,
    scannedAt,
    totalJobs: data.jobs.length,
    rawJobs,
    priorIds,
    isBaseline,
    vocab,
  });
}
