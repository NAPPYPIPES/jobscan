// URL builders + single-retry fetch wrapper. Adapters import these rather
// than calling fetch directly so the retry policy is consistent across
// ATSs.

// content=true makes the list response include each job's full HTML
// description. Same number of HTTP requests as without; payload grows
// significantly but still fits in a single fetch and saves N+1 per-job
// calls.
export const greenhouseUrl = (slug: string) =>
  `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

export const ashbyUrl = (slug: string) =>
  `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

export const leverUrl = (slug: string) =>
  `https://api.lever.co/v0/postings/${slug}`;

// Single retry on network error or 5xx. 404 and other 4xx are real
// answers (typo'd slug, deleted board), not transient — don't retry
// those, would just waste a second per bad slug.
export async function fetchWithRetry(url: string): Promise<Response> {
  try {
    const res = await fetch(url);
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 500));
      return fetch(url);
    }
    return res;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetch(url);
  }
}
