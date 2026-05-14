// Shared types + constants for the scan domain. The DB schema imports
// Ats and Level from here so the scan logic is the source of truth for
// these concepts — the DB just persists them.

export type Ats = "greenhouse" | "ashby" | "lever" | "workday";
export type Level = "BV" | "HIGH" | "MEDIUM" | "LOW";

// "tech" (default) classifies titles using Silicon-Valley conventions
// (VP Sales = senior). "finserv" uses bank conventions (Managing
// Director = senior, VP alone = mid-level). Different classifier per
// sector — see classifyRoleTech / classifyRoleFinserv in filter.ts.
//
// "other" is exposed in the UI sector filter so users can group/exclude
// non-standard companies — anything not strictly tech or finserv.
export type Sector = "tech" | "finserv" | "other";

// Funding / corporate stage. Mostly informational at the Target level;
// the scoring rubric's stage dimension uses it to pick an anchor band.
export type CompanyStage =
  | "public_enterprise"
  | "partnership"
  | "late_stage"
  | "growth"
  | "early"
  | "pe_owned"
  | "large_financial";

export type Target = {
  ats: Ats;
  slug: string;
  displayName: string;
  sector?: Sector;
  stage?: CompanyStage;
};

// Raw ATS API shapes (only the fields we actually use)
export type GreenhouseJob = {
  id: number;
  title: string;
  location: { name: string };
  // Present only when fetched with ?content=true. HTML, double-encoded
  // entities (e.g. "&lt;p&gt;..." not "<p>...").
  content?: string;
};
export type GreenhouseResponse = { jobs: GreenhouseJob[] };

export type AshbyJob = {
  id: string;
  title: string;
  location: string;
  secondaryLocations?: { location: string }[];
  isListed: boolean;
  // Plaintext version; descriptionHtml is also available but we don't need it.
  descriptionPlain?: string;
};
export type AshbyResponse = { jobs: AshbyJob[] };

// Lever's response is a top-level array (no envelope). Title field is
// `text`, and `categories.location` is the primary while
// `categories.allLocations` holds the multi-location footprint.
export type LeverJob = {
  id: string;
  text: string;
  categories: {
    location?: string;
    allLocations?: string[];
  };
  descriptionPlain?: string;
};
export type LeverResponse = LeverJob[];

// Workday's POST /jobs endpoint. Title is `title`, `externalPath` is
// the stable per-job slug we use as id (and reuse to build the apply
// URL). Multi-location jobs return locationsText="N Locations" with no
// list — we treat those as in-scope since we can't tell from the list
// endpoint whether NYC is one of the N. `bulletFields[0]` is typically
// the requisition id (kept for reference, not used as primary key).
export type WorkdayJob = {
  title: string;
  externalPath: string;
  locationsText: string;
  // Optional in practice — most tenants populate it for every job, but
  // a few omit it. The Workday adapter's parsePostedOnDays handles
  // undefined defensively.
  postedOn?: string;
  bulletFields: string[];
};
export type WorkdayResponse = {
  total: number;
  jobPostings: WorkdayJob[];
};

// Per-job endpoint — returns the actual location list for multi-location
// postings (the list endpoint only gives the "N Locations" placeholder).
export type WorkdayJobDetail = {
  jobPostingInfo: {
    location: string;
    additionalLocations?: string[];
    startDate?: string;
  };
};

// Internal shape adapters normalize to before handing off to the shared
// post-fetch pipeline (lib/scan/core.ts). Lets each adapter stay tiny —
// just URL fetch + per-ATS field mapping. Description is optional —
// Workday skips it (would require N+1 fetches per scan); Greenhouse /
// Ashby / Lever populate it from the list response.
export type RawJob = {
  id: string;
  title: string;
  location: string;
  description?: string;
};

// Pipeline output shapes. `description` is carried through from the
// adapter (when available) so the post-classify scoring step in run.ts
// can pass it to Claude without a re-fetch. Not persisted to DB.
export type MatchOut = {
  id: string;
  level: Level;
  title: string;
  location: string;
  isNew: boolean;
  description?: string;
};

export type CompanyResult = {
  slug: string;
  displayName: string;
  ats: Ats;
  scannedAt: string;
  total: number;
  locationMatchCount: number;
  levelBreakdown: Record<Level, number>;
  newCount: number;
  matches: MatchOut[];
};

export const LEVEL_ORDER: Record<Level, number> = { BV: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
export const LEVEL_LABEL: Record<Level, string> = { BV: "BV", HIGH: "HIGH", MEDIUM: "MED", LOW: "LOW" };
