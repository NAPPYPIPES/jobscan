import { htmlToText } from "@/lib/scan/filter";
import type { Ats } from "@/lib/scan/types";

// Cap on the extract passed to Claude. ~3500 chars ≈ 600 words ≈ ~800
// input tokens. Sized to retain role summary + responsibilities +
// requirements sections while dropping company boilerplate, benefits,
// and EEO statements. Longer than this is almost always padding.
const EXTRACT_CHAR_CAP = 3500;

// Head slice taken unconditionally — the first ~270 words of a JD
// almost always contains the role summary, even if some company
// boilerplate is mixed in.
const HEAD_CHARS = 1500;

// Per-anchor slice length. ~140 words is enough to capture the
// bulleted list under a "Responsibilities" or "Requirements" header.
const SECTION_CHARS = 800;

// Section anchors that signal high-signal content (responsibilities,
// requirements, qualifications). htmlToText already lowercased and
// whitespace-collapsed the JD, so anchors are substring patterns
// rather than newline-anchored headers.
const SECTION_ANCHORS: RegExp[] = [
  /\bwhat you('ll| will) (do|be doing)\b/,
  /\bresponsibilities?\b/,
  /\bwhat you('ll| will) need\b/,
  /\b(required|minimum) qualifications?\b/,
  /\bqualifications?\b/,
  /\byou (have|bring|will have|'ll have)\b/,
  /\b(must|nice to) have\b/,
  /\bpreferred qualifications?\b/,
  /\babout the role\b/,
  /\bthe opportunity\b/,
];

// Compresses a fetched JD into a high-signal extract for Claude
// scoring. Always includes the first HEAD_CHARS chars (role summary
// region), then finds every section anchor in the remaining text and
// includes SECTION_CHARS of context after each hit. Overlapping ranges
// are merged. Final result is capped at EXTRACT_CHAR_CAP.
export function extractScoringText(plain: string): string {
  if (!plain) return "";
  if (plain.length <= EXTRACT_CHAR_CAP) return plain;

  const ranges: Array<[number, number]> = [[0, HEAD_CHARS]];
  for (const re of SECTION_ANCHORS) {
    let from = HEAD_CHARS;
    while (from < plain.length) {
      const m = re.exec(plain.slice(from));
      if (!m) break;
      const start = from + m.index;
      const end = Math.min(plain.length, start + SECTION_CHARS);
      ranges.push([start, end]);
      from = end;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  const joined = merged.map(([s, e]) => plain.slice(s, e)).join(" … ");
  return joined.length > EXTRACT_CHAR_CAP
    ? joined.slice(0, EXTRACT_CHAR_CAP) + "…"
    : joined;
}

// Re-fetch a single role's description from its source ATS. Used by
// the decoupled /api/cron/score endpoint and one-off backlog scripts
// — we don't store descriptions in the DB, so anything that needs
// the JD text after the fact has to go back to the source.
//
// Returns null when the role is no longer listed (closed/removed) or
// when the ATS doesn't expose descriptions in its list endpoint
// (Workday — by design, we don't pay the per-job fetch cost just to
// score those tenants).
export async function fetchDescription(
  ats: Ats,
  slug: string,
  jobId: string,
): Promise<string | null> {
  if (ats === "greenhouse") {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: string };
    return json.content ? htmlToText(json.content) : null;
  }
  if (ats === "ashby") {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { jobs?: { id: string; descriptionPlain?: string }[] };
    const job = json.jobs?.find((j) => j.id === jobId);
    return job?.descriptionPlain ?? null;
  }
  if (ats === "lever") {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = (await res.json()) as { id: string; descriptionPlain?: string }[];
    const job = arr.find((j) => j.id === jobId);
    return job?.descriptionPlain ?? null;
  }
  // Workday: no description on list endpoint, intentionally not
  // N+1-fetching for scoring. Caller treats null as "skip this row,
  // leave fit_score null."
  return null;
}
