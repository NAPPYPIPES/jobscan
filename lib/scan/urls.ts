import { getWorkdayBoards } from "@/db/workday-tenants";
import type { Ats } from "./types";

// Public apply URL per ATS. Greenhouse / Ashby / Lever produce stable
// slug-based URLs (sync). Workday is per-tenant: we look up host +
// board from the workday_tenants DB table (cached in module memory by
// db/workday-tenants); the jobId IS the externalPath returned by the
// search endpoint (already starts with "/job/...").
//
// Async because the workday branch needs the DB lookup. The cache
// makes warm-function calls sub-ms. Callers are all server-side
// (server components and API routes) so async-await is fine; we never
// import this from a client component.
export async function jobUrl(ats: Ats, slug: string, jobId: string): Promise<string> {
  if (ats === "greenhouse") {
    return `https://job-boards.greenhouse.io/${slug}/jobs/${jobId}`;
  }
  if (ats === "ashby") {
    return `https://jobs.ashbyhq.com/${slug}/${jobId}`;
  }
  if (ats === "lever") {
    return `https://jobs.lever.co/${slug}/${jobId}`;
  }
  // workday
  const boards = await getWorkdayBoards();
  const cfg = boards[slug];
  if (!cfg) {
    // Graceful: still produce a clickable URL even if config is missing.
    // Real fix is adding the slug to workday_tenants via ingest-config.
    return `https://${slug}.myworkdayjobs.com${jobId}`;
  }
  return `https://${slug}.${cfg.host}.myworkdayjobs.com/${cfg.board}${jobId}`;
}
