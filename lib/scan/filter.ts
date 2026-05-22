import type { LoadedPersonalKeywords } from "@/db/personal-keywords";
import type { Level, Sector } from "./types";

// ──────────────────────────────────────────────────────────────────────
// Pure-function classifier
// ──────────────────────────────────────────────────────────────────────
// The classifier takes its personal-vocabulary arg explicitly. Callers
// fetch keywords once at the top of a scan run via
// db/personal-keywords.getPersonalKeywords() and thread them down
// through buildCompanyResult → classifyRole / applyDescriptionShift.
// Keeping the classifier pure (no module-load DB call, no
// module-scoped mutable state) means it's easy to test and the
// "what keywords applied to this scan" data flow is visible at the
// call site.
//
// Generic vocabularies (engineering skips, GTM tokens, finserv non-GTM
// skips, etc.) stay as in-file constants — they're useful-to-everyone
// defaults, not personal preferences.

export type ClassifierVocab = LoadedPersonalKeywords;

// ──────────────────────────────────────────────────────────────────────
// HTML / text helpers
// ──────────────────────────────────────────────────────────────────────

// HTML → plaintext for description scanning. Greenhouse returns the
// content field with double-encoded HTML entities (&lt;p&gt; not <p>),
// so we decode entities first, then strip tags, then decode any
// nested entities, then collapse whitespace. Lowercased at the end so
// callers can use case-insensitive substring/regex matching directly.
export function htmlToText(html: string): string {
  if (!html) return "";
  const decode = (s: string) =>
    s
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  return decode(decode(html))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Location filter — applied before the role classifier. Defaults match
// the original tool's NYC + US-remote scope. Edit these to match your
// own geographic constraints; same shape works for any metro.
//
// Workday's list endpoint returns "N Locations" for multi-location jobs
// (the actual city list isn't exposed without per-job fetches that
// would N+1 the scan). We accept those as in-scope so we don't miss
// senior roles at big tenants.
//
// US-remote variants are handled tolerantly — "Remote, US",
// "Remote United States", "U.S. Remote" etc. all qualify.
export function isInScope(location: string): boolean {
  const l = location.toLowerCase().trim();
  if (l.includes("new york") || l.includes("nyc")) return true;
  if (l.includes("remote")) {
    const lNorm = l.replace(/\./g, "");
    if (lNorm.includes("united states")) return true;
    if (lNorm.includes("usa")) return true;
    if (/\bus\b/.test(lNorm)) return true;
  }
  if (/^\d+ locations$/.test(l)) return true;
  return false;
}

// Classifier-stage location disqualifier. Runs after isInScope (which
// is broader) to catch state-remote postings ("Remote - California,
// USA") and intl tags that slip through. NYC and bare US-Remote
// always qualify and short-circuit before the disqualifier lists run.
export function isLocationDisqualified(location: string): boolean {
  const n = location.toLowerCase();

  if (n.includes("new york") || n.includes("nyc") || n.includes("manhattan")) {
    return false;
  }

  const US_REMOTE_PATTERNS = [
    /\bremote\s*-\s*usa?\b/,
    /\bremote,\s*usa?\b/,
    /\bremote\s*-\s*united states\b/,
    /\bremote,\s*united states\b/,
    /\bus-remote\b/,
  ];
  if (US_REMOTE_PATTERNS.some((p) => p.test(n))) return false;

  const SINGLE_STATE_REMOTE = [
    "remote - california", "remote, california",
    "remote - texas", "remote, texas",
    "remote - florida", "remote, florida",
    "remote - washington", "remote, washington",
    "remote - colorado", "remote, colorado",
    "remote - illinois", "remote, illinois",
    "remote - massachusetts", "remote, massachusetts",
    "remote - georgia", "remote, georgia",
  ];
  for (const p of SINGLE_STATE_REMOTE) {
    if (n.includes(p)) return true;
  }

  const NON_NY_CITIES = [
    "san francisco", "los angeles", "chicago", "austin", "seattle",
    "boston", "denver", "atlanta", "miami", "portland",
    "dallas", "houston", "philadelphia", "washington dc",
  ];
  if (!n.includes("remote")) {
    for (const city of NON_NY_CITIES) {
      if (n.includes(city)) return true;
    }
  }

  const INTERNATIONAL_PATTERNS = [
    "london", "dublin", "amsterdam", "paris", "berlin",
    "singapore", "tokyo", "hong kong", "sydney", "toronto", "bangalore",
    "tel aviv",
  ];
  if (!n.includes("remote")) {
    for (const intl of INTERNATIONAL_PATTERNS) {
      if (n.includes(intl)) return true;
    }
  }

  return false;
}

export function normalizeTitle(title: string): string {
  let s = title.toLowerCase();
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\bvice president\b/g, "vp");
  s = s.replace(/\bchief revenue officer\b/g, "cro");
  s = s.replace(/\b(of|the|for|and|to|a|an)\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function hasKeyword(normalized: string, keyword: string): boolean {
  const pattern = keyword.includes(" ") ? `\\b${keyword}` : `\\b${keyword}\\b`;
  return new RegExp(pattern).test(normalized);
}

// ──────────────────────────────────────────────────────────────────────
// Generic classifier vocabularies (stay in code — useful for any user)
// ──────────────────────────────────────────────────────────────────────

// Sub-target-level titles that get filtered at the rule layer — never
// inserted into matches.* at all. Pre-AI guard: cheapest possible
// way to keep these off the radar regardless of how the AI tiers
// would have read them.
//
// "analyst" — every flavor (Senior Analyst, Principal Analyst,
//   Strategic Analyst, GTM Analyst, etc.). Even "Principal Analyst"
//   is below the candidate's Director-and-up target. The rare
//   "Director, Analyst Relations" leadership role would survive only
//   if it doesn't have "analyst" as a standalone token in the title;
//   if a real one slips through and gets filtered, add an explicit
//   exception then.
// "representative" — captures Sales Rep, Customer Rep, Partner
//   Development Representative, Account Representative, Technical
//   Rep, etc. SDR/BDR already covered by separate entries.
const SKIP_KEYWORDS = [
  "sdr", "bdr", "intern", "junior", "associate",
  "analyst",
  "representative",
  "sales development representative", "business development representative",
];

const ENGINEERING_FUNCTION_SKIPS = [
  "software engineer", "software developer",
  "data engineer", "data scientist",
  "machine learning engineer", "ml engineer",
  "devops", "site reliability", "sre",
  "infrastructure engineer", "platform engineer",
  "security engineer", "cybersecurity",
  "quantitative", "quant analyst", "quant researcher",
  "systems engineer", "systems architect",
  "solutions engineer",
  "sales engineer",
  "engineering manager", "director engineering", "director of engineering",
  "vp engineering", "vp of engineering",
  "head engineering", "head of engineering",
  "chief technology",
  "cto",
];

const ENGINEERING_EXCEPTIONS = [
  "value engineering",
  "business value",
  "revenue engineer",
];

function hitsEngineeringSkip(normalized: string): boolean {
  if (ENGINEERING_EXCEPTIONS.some((p) => hasKeyword(normalized, p))) {
    return false;
  }
  return ENGINEERING_FUNCTION_SKIPS.some((p) => hasKeyword(normalized, p));
}

const UNIVERSAL_HARD_SKIPS = [
  "recruiter", "recruiting",
];

const HIGH_PHRASES = [
  "vp sales", "vp gtm", "head sales", "head gtm", "head revenue", "cro",
  // Startup / exec leadership. CTO + Chief Technology are killed
  // upstream by hitsEngineeringSkip, so adding bare "chief" here is
  // safe. "chief staff" matches "Chief of Staff" after normalizeTitle
  // strips the "of".
  "coo", "chief operating officer",
  "chief commercial officer", "chief customer officer",
  "chief strategy officer", "chief staff",
  "president", "general manager", "gm",
];

const MEDIUM_PHRASES = [
  "director sales", "director gtm", "enterprise ae", "strategic account",
  "gtm strategy", "revenue operations", "sales operations",
  "revops", "revenue ops",
  "sales strategy", "customer strategy",
  "partnerships", "partnership",
];

const LOW_KEYWORDS = [
  "sales", "gtm", "revenue",
  "account executive", "customer success",
  "partner", "partners",
];

// Sector-neutral leadership domains. A "Head of Strategy and Operations"
// or "Head of AI Adoption" has no GTM token in the title but the JD
// frequently describes GTM outcomes (revenue attribution, seller
// enablement, pipeline). We default head/vp/director + these tokens to
// MEDIUM so the description reaches Sonnet, which can read the JD and
// confirm or reject the GTM angle. Engineering variants ("Director,
// Engineering Strategy") are already filtered by ENGINEERING_FUNCTION_
// SKIPS upstream, so this branch doesn't reopen the engineering door.
const STRATEGY_LEADERSHIP_DOMAINS = [
  "strategy",
  "operations",
  "activation",
  "growth",
  "transformation",
  "enablement",
  "commercialization",
  "staff",
  "operator",
  "ai strategy",
  "ai adoption",
  "ai rollout",
  "ai transformation",
  "ai enablement",
  "ai capability",
  "ai use case",
];

// "chief" and "founding" added for startup exec titles (Chief X Officer,
// Founding GTM, Founding Operator). hitsEngineeringSkip runs first and
// kills CTO/Chief Technology before this branch is reached.
const SENIORITY_HIGH = ["head", "vp", "chief", "founding"];
const SENIORITY_MED = ["director"];
const GTM_TOKENS = ["sales", "gtm", "revenue"];

// Top-level entry point. Dispatches on sector. Personal vocab
// (bv_phrases) is passed in by the caller — see the run.ts / core.ts
// call chain.
//
// `permissive`: when true, roles that pass every hard-skip filter but
// don't match a positive HIGH/MED/LOW domain pattern default to MEDIUM
// (instead of null). Used by the Workday adapter where the cheap
// title-only classifier is too narrow — Haiku will triage everything
// in-scope and Sonnet escalates the keepers. Hard-skip filters
// (engineering, recruiter, location, sub-target seniority, finserv
// non-GTM/tech) still apply so we don't burn AI calls on obvious noise.
export function classifyRole(
  title: string,
  sector: Sector,
  location: string | undefined,
  vocab: ClassifierVocab,
  permissive = false,
): Level | null {
  const n = normalizeTitle(title);
  for (const w of UNIVERSAL_HARD_SKIPS) {
    if (hasKeyword(n, w)) return null;
  }
  if (location && isLocationDisqualified(location)) return null;
  return sector === "finserv"
    ? classifyRoleFinserv(title, vocab, permissive)
    : classifyRoleTech(title, vocab, permissive);
}

function classifyRoleTech(
  title: string,
  vocab: ClassifierVocab,
  permissive: boolean,
): Level | null {
  const n = normalizeTitle(title);

  if (hitsEngineeringSkip(n)) return null;
  for (const w of SKIP_KEYWORDS) {
    if (hasKeyword(n, w)) return null;
  }

  const hasGtmToken = GTM_TOKENS.some((t) => hasKeyword(n, t));

  if (vocab.bvPhrases.some((p) => hasKeyword(n, p))) return "BV";
  if (HIGH_PHRASES.some((p) => hasKeyword(n, p))) return "HIGH";
  if (hasGtmToken && SENIORITY_HIGH.some((s) => hasKeyword(n, s))) return "HIGH";
  if (MEDIUM_PHRASES.some((p) => hasKeyword(n, p))) return "MEDIUM";
  if (hasGtmToken && SENIORITY_MED.some((s) => hasKeyword(n, s))) return "MEDIUM";

  // Strategy-leadership branch — see STRATEGY_LEADERSHIP_DOMAINS header.
  const isSenior =
    SENIORITY_HIGH.some((s) => hasKeyword(n, s)) ||
    SENIORITY_MED.some((s) => hasKeyword(n, s));
  if (
    isSenior &&
    STRATEGY_LEADERSHIP_DOMAINS.some((d) => hasKeyword(n, d))
  ) return "MEDIUM";

  if (LOW_KEYWORDS.some((w) => hasKeyword(n, w))) return "LOW";
  return permissive ? "MEDIUM" : null;
}

// ──────────────────────────────────────────────────────────────────────
// Finserv classifier — separate vocabulary from tech.
// ──────────────────────────────────────────────────────────────────────

const FINSERV_TECH_SKIPS = [
  "engineer", "engineering", "developer", "architect",
  "infrastructure", "software", "technology",
];

const FINSERV_NONGTM_SKIPS = [
  "risk",
  "compliance",
  "audit", "auditor",
  "trading", "trader",
  "underwriting", "underwriter",
  "actuary", "actuarial",
  "counsel", "attorney",
  "regulatory",
  "branch",
];

// AVP / Assistant VP intentionally NOT here. At banks (JPM, Citi, BoA)
// AVP is a junior post-MBA tier, but at exchanges, fintechs, and SaaS
// finserv (Nasdaq, Mastercard, Capital One) AVP commonly designates a
// senior individual-contributor leadership role (e.g. "AVP, Enterprise
// Solutions AI Leader"). We accept AVP into the AI triage pool and let
// Haiku/Sonnet read the JD to decide.
const FINSERV_STANDALONE_SKIPS = [
  "associate", "analyst",
];

const FINSERV_HIGH_HEAD_DOMAINS = [
  "sales", "distribution", "business development",
  "strategic partner", "customer success",
  "gtm", "client engagement", "advisor",
];

const FINSERV_HIGH_MD_DOMAINS = [
  "business development", "sales", "distribution",
  "strategic partner", "gtm", "customer success",
  "client engagement", "client strategy",
];

const FINSERV_MED_DIRECTOR_DOMAINS = [
  "business development", "sales", "distribution",
  "strategic partner", "customer success",
  "gtm", "client engagement", "enterprise solution",
];

const FINSERV_MED_VP_DOMAINS = [
  "business development", "strategic partner", "distribution",
  "customer success", "gtm",
];

const FINSERV_HIGH_CHIEF_PHRASES = [
  "chief revenue officer",
  "chief sales officer",
  "chief customer officer",
  "chief commercial officer",
  "chief operating officer",
  "chief staff", // matches "Chief of Staff" after normalizeTitle strips "of"
];

// vocab is currently unused in finserv path — finserv-specific BV
// phrases aren't supported separately from the tech path's BV match.
// Signature accepts it so the dispatcher stays clean.
function classifyRoleFinserv(
  title: string,
  _vocab: ClassifierVocab,
  permissive: boolean,
): Level | null {
  const n = normalizeTitle(title);

  if (hitsEngineeringSkip(n)) return null;
  for (const w of FINSERV_TECH_SKIPS) {
    if (hasKeyword(n, w)) return null;
  }
  for (const w of FINSERV_NONGTM_SKIPS) {
    if (hasKeyword(n, w)) return null;
  }
  for (const w of FINSERV_STANDALONE_SKIPS) {
    if (hasKeyword(n, w)) return null;
  }

  if (FINSERV_HIGH_CHIEF_PHRASES.some((p) => hasKeyword(n, p))) return "HIGH";

  if (
    hasKeyword(n, "managing director") &&
    FINSERV_HIGH_MD_DOMAINS.some((d) => hasKeyword(n, d))
  ) return "HIGH";

  if (
    hasKeyword(n, "head") &&
    FINSERV_HIGH_HEAD_DOMAINS.some((d) => hasKeyword(n, d))
  ) return "HIGH";

  if (hasKeyword(n, "cro")) return "MEDIUM";

  if (hasKeyword(n, "business value")) return "MEDIUM";

  if (
    hasKeyword(n, "director") &&
    FINSERV_MED_DIRECTOR_DOMAINS.some((d) => hasKeyword(n, d))
  ) return "MEDIUM";

  if (
    hasKeyword(n, "vp") &&
    FINSERV_MED_VP_DOMAINS.some((d) => hasKeyword(n, d))
  ) return "MEDIUM";

  // AVP-titled finserv roles default to MEDIUM and rely on AI triage to
  // separate exchange/fintech AVP-leaders from bank AVP-juniors.
  if (hasKeyword(n, "avp")) return "MEDIUM";

  if (hasKeyword(n, "managing director")) return "LOW";
  if (hasKeyword(n, "vp")) return "LOW";

  return permissive ? "MEDIUM" : null;
}

// ──────────────────────────────────────────────────────────────────────
// Description signal scan
// ──────────────────────────────────────────────────────────────────────

const POSITIVE_PATTERNS: RegExp[] = [
  /\bbusiness value\b/,
  /\bvalue\s+(engineer|consult|architect|advis|strateg|realiz|transform|manag|creat|acceler|servic|sell|deliver|enable|propos|narrativ)/,
  /\bc[-\s]?(suite|level)\b/,
  /\bexecutive selling\b/,
  /\bboard[-\s]?level\b/,
  /quota[^.]{0,150}\$\s?\d{1,3}\s?m\b/,
  /\$\s?\d{1,3}\s?m[^.]{0,150}quota/,
  /\b(manage|build)\s+(a\s+|the\s+)?team\b/,
  /\bhire and develop\b/,
];

const NEGATIVE_PATTERNS: RegExp[] = [
  /\bentry[-\s]?level\b/,
  /\b0[-\s]?2\s+years\b/,
  /\b1[-\s]?3\s+years\b/,
  /\b(sdr|bdr)\b/,
  /\bbusiness development representative\b/,
];

function isSmbWithoutEnterprise(d: string): boolean {
  const hasSmb = /\b(smb|mid[-\s]?market)\b/.test(d);
  const hasEnterprise = /\benterprise\b/.test(d);
  return hasSmb && !hasEnterprise;
}

const LEVEL_RANK: Record<Level, number> = { BV: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const RANK_TO_LEVEL: Level[] = ["BV", "HIGH", "MEDIUM", "LOW"];

export function applyDescriptionShift(
  level: Level,
  description: string | undefined,
  sector: Sector,
  vocab: ClassifierVocab,
): Level | null {
  if (!description) return level;

  const positiveCount =
    POSITIVE_PATTERNS.reduce((n, p) => n + (p.test(description) ? 1 : 0), 0) +
    (sector === "finserv"
      ? vocab.finservBonusPositivePatterns.reduce(
          (n, p) => n + (p.test(description) ? 1 : 0),
          0,
        )
      : 0);
  const negativeCount =
    NEGATIVE_PATTERNS.reduce((n, p) => n + (p.test(description) ? 1 : 0), 0)
    + (isSmbWithoutEnterprise(description) ? 1 : 0);
  const hardCapped = vocab.hardCapLowPatterns.some((p) => p.test(description));

  if (hardCapped) return "LOW";

  const net = positiveCount - negativeCount;
  if (net === 0) return level;

  if (net > 0) {
    if (level === "MEDIUM" && net < 2) return level;
    if (level === "BV") return level;
    const newRank = LEVEL_RANK[level] - 1;
    return RANK_TO_LEVEL[newRank];
  }

  if (level === "LOW") return null;
  const newRank = LEVEL_RANK[level] + 1;
  return RANK_TO_LEVEL[newRank];
}
