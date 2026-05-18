// Configurable fit-scoring rubric. Five dimensions, weighted average,
// returns 0–10. The model produces only the dimension scores; the
// weighted average and any caps are computed deterministically in
// lib/fit/score.ts so the policy lives in one place.
//
// Edit DEFAULT_RUBRIC below to tune for your priorities:
//   - Dimension weights: must sum to 1.0 (validateRubric enforces).
//   - Anchors: written generically and reference the user_profile that
//     scripts/ingest-resume.ts populates. The scoring prompt substitutes
//     the user's target_roles / industries / seniority / etc. at call
//     time so the rubric stays user-agnostic in code.
//   - hardExclusions: flag names the model can set that force a 0.0
//     overall regardless of dimension scores. Defaults to healthcare
//     and relocation; remove either if it isn't a hard line for you.
//   - icRoleCap: ceiling applied when the model sets the ic_role flag.
//     Defaults to 7.9, which keeps strong AE roles out of the digest
//     (HIGH band starts at 8.0). Set to 10.0 to disable the cap.
//   - alertThreshold: minimum fit_score for inclusion in the daily
//     digest. Defaults to 7.5.

export type DimensionAnchor = {
  score: number;
  description: string;
};

export type DimensionScale = {
  description: string;
  anchors: DimensionAnchor[];
};

export type Dimension =
  | "function"
  | "seniority"
  | "industry"
  | "stage"
  | "location";

export type ScoringRubric = {
  dimensions: Record<Dimension, { weight: number; scale: DimensionScale }>;
  hardExclusions: string[];
  icRoleCap: number;
  alertThreshold: number;
};

export const DEFAULT_RUBRIC: ScoringRubric = {
  dimensions: {
    // Function dominates the composite (65%) because the candidate's
    // target list pre-filters industry and stage — what's actually
    // discriminating across roles in the watchlist is whether the
    // role's primary function maps to the candidate's actual demonstrated
    // skills (team leadership, ROI quantification, customer/exec
    // relationships, sales process design, value selling). Title alone
    // is a weak signal — the JD's required skills + responsibilities
    // are the real anchor.
    function: {
      weight: 0.65,
      scale: {
        description:
          "How closely the role's required skills + actual responsibilities map to what the candidate has DONE — not just whether the title looks similar. Read the JD's responsibilities and required skills sections, compare to the candidate's resume work history and Skills sections (resume #22 and #26). Title is corroborating evidence; the work itself is the anchor.",
        anchors: [
          { score: 10, description: "Exact match for one of the candidate's target roles AND the JD's required skills (team leadership, ROI/value quantification, executive narrative, enterprise sales motion, GTM process design) appear repeatedly in the candidate's resume." },
          { score: 9,  description: "Adjacent title in the same family (Head of Revenue / VP GTM / Director Strategic Sales) AND most required skills are demonstrated in the candidate's resume — even if the title isn't an exact match, the day-to-day work is." },
          { score: 8,  description: "Title is adjacent OR skills overlap is strong but not both. e.g. an exact-title role at a company stage where the candidate's specific motion (enterprise vs SMB) doesn't quite fit." },
          { score: 6,  description: "Same broad area but different specialty — e.g. RevOps / Sales Ops when target is Sales leadership; Solutions Engineering when target is Value Engineering. Some skills overlap, but day-to-day work diverges." },
          { score: 4,  description: "Related but tangential — Customer Success / Account Management when target is Sales leadership; Partner roles when target is direct enterprise sales. Limited skill overlap." },
          { score: 2,  description: "Different function in the same org type — e.g. Marketing / Product Marketing / Brand / Affiliate / Performance Marketing / Ad Tech when target is Sales/Value leadership. Includes 'Client Development' roles whose primary motion is campaign management or merchant-affiliate optimization rather than direct enterprise deal-closing." },
          { score: 0,  description: "Outside the candidate's function entirely. Explicit exclusions: Software / Platform / ML Engineering; AI Solutions / Data Science / Analytics Engineering (CTO/CIO-track tech leadership even when titled 'Director' or 'Global Head' at a FinServ employer); Product / UX / Visual Design / Art Direction; Finance ops / FP&A / Controllership; HR / People / Talent. Title signals that trigger 0.0 regardless of seniority modifier or company prestige: 'Art Director', 'Director of Design', 'Head/Director of Engineering / Technology / AI Solutions / Data Science / Index Build / Platform', 'Global Head of [any technology portfolio]', 'HR Business Partner', 'Director, People'." },
        ],
      },
    },
    // Seniority is now a bell curve around required YOE rather than a
    // strict "higher title = better" ladder. The candidate has 15+
    // years; roles asking for 10-12 years are the peak match (target
    // band, not over-qualified, not stretching). Roles asking for 5
    // years suggest under-leveling. Roles asking for 15+ are at the
    // edge — possibly looking for someone too senior, or just listing
    // an aspirational floor. Title corroborates the band but the YOE
    // requirement is the more reliable signal when both are present.
    seniority: {
      weight: 0.15,
      scale: {
        description:
          "Bell curve around the JD's required YOE. The candidate has 15+ years of experience. Peak fit is roles asking for 10-12 years (target seniority band, no over- or under-leveling). Tapers in both directions: <8 years asked = over-qualified; 15+ years asked = at the edge / possibly seeking SVP-tier the candidate is bordering on. Title is corroborating evidence but the YOE requirement is the primary signal when present. When YOE isn't stated, infer from title.",
        anchors: [
          { score: 10, description: "JD asks for 10-12 years experience (peak band) OR title is Director / Senior Director / VP of GTM/Sales/Revenue/Value (target leadership tier). Candidate is exactly target." },
          { score: 9,  description: "JD asks for 8-10 years OR 12-15 years (one band off the peak). OR title is Head of [function] / SVP of [function] — slightly aspirational but in range." },
          { score: 8,  description: "JD asks for 6-8 years OR title is Senior Manager / Manager-of-managers — slightly below target band, candidate would be top of the range." },
          { score: 7,  description: "JD asks for 15+ years explicitly (often paired with VP/SVP/C-suite titles) — candidate is at the edge of qualifying; might be aspirational." },
          { score: 5,  description: "JD asks for 4-6 years OR title is Manager — candidate clearly over-qualified, but not absurdly so." },
          { score: 3,  description: "JD asks for 3-5 years OR title is Senior IC + a function (Senior Account Executive, Senior Value Consultant) — candidate over-qualified." },
          { score: 1,  description: "JD asks for <3 years OR title is Mid-level IC / Associate." },
          { score: 0,  description: "Entry-level / Analyst / new-grad." },
        ],
      },
    },
    // Industry is reduced to 10% because the watchlist already
    // pre-filters to companies the candidate considers in-scope. The
    // dimension still matters for sub-industry calibration (e.g. an
    // AI-native infra company vs. a consumer B2C app at the same
    // stage), but it shouldn't dominate the composite the way it did
    // when the watchlist was broader.
    industry: {
      weight: 0.10,
      scale: {
        description:
          "Sub-industry calibration within the watchlist. Score generously when the company's domain matches the candidate's strongest experience; score conservatively for buyer types far from enterprise B2B (consumer B2C, dev-tools, crypto-only). Industries on the hard_exclusions list set the matching flag and force 0 across dimensions.",
        anchors: [
          { score: 10, description: "Candidate's strongest industry experience (financial services, enterprise B2B SaaS, AI-native enterprise infra)." },
          { score: 8,  description: "Adjacent regulated or enterprise industry — transferable buyer + motion." },
          { score: 6,  description: "Different B2B industry, same buyer type." },
          { score: 4,  description: "B2C or pure dev-tool when background is enterprise B2B (consumer apps like Spotify, Airbnb)." },
          { score: 3,  description: "FinServ / fintech employer but the role's primary BUYER is the individual consumer / cardholder / retail customer rather than an enterprise. Examples: consumer loyalty programs, retail card-benefits commercialization, consumer travel marketing, affiliate-merchant ad sales where merchants are SMB/mid-market performance advertisers. The brand looks right but the enterprise B2B buyer is absent." },
          { score: 2,  description: "Industry on the candidate's hard_exclusions list (also set the corresponding flag — composite forced to 0)." },
        ],
      },
    },
    // Stage is reduced to 5% — same logic as industry. The watchlist
    // already filters to stages the candidate is interested in;
    // stage is now a tiebreaker between two otherwise-equal roles.
    stage: {
      weight: 0.05,
      scale: {
        description:
          "Funding / maturity stage. Defaults assume the candidate prefers high-leverage growth-stage opportunities; tiebreaker only.",
        anchors: [
          { score: 10, description: "Series B / C / D — high-leverage growth stage." },
          { score: 9,  description: "Late-stage private or public enterprise." },
          { score: 6,  description: "PE-owned or unknown stage." },
          { score: 4,  description: "Series A — early but viable." },
          { score: 2,  description: "Seed / pre-seed — likely too early for senior IC + management." },
        ],
      },
    },
    // Location is reduced to 5% because non-NYC-metro / non-US-remote
    // roles should be hard-flagged as relocation_required (which
    // forces composite to 0) rather than nudged via a dimension
    // score. The 5% remaining weight calibrates between "in-office
    // NYC vs. remote-from-NYC vs. hybrid-NYC" — geography signal IS
    // captured, but it's not what determines whether a role surfaces.
    location: {
      weight: 0.05,
      scale: {
        description:
          "Geographic fit. Anything outside NYC / NYC metro / US-remote should be flagged relocation_required (forces composite to 0); within those locations, this dimension calibrates between fully remote, hybrid, and in-office NYC.",
        anchors: [
          { score: 10, description: "NYC / NYC metro in-office or hybrid; OR fully US-remote." },
          { score: 8,  description: "Hybrid with NYC listed as one of multiple options." },
          { score: 4,  description: "Single non-NYC US city (set relocation_required flag)." },
          { score: 0,  description: "International / outside US (set relocation_required flag)." },
        ],
      },
    },
  },
  hardExclusions: ["healthcare_excluded", "relocation_required"],
  icRoleCap: 7.9,
  alertThreshold: 7.5,
};

// Validate at module load — catches a typo or bad edit that would
// otherwise silently produce nonsense fit scores. Weights summing to
// anything other than 1.0 means the weighted average is no longer
// bounded at 10.
export function validateRubric(rubric: ScoringRubric): void {
  const weights = Object.values(rubric.dimensions).map((d) => d.weight);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 0.001) {
    throw new Error(
      `Rubric dimension weights must sum to 1.0; got ${sum.toFixed(3)}.`,
    );
  }
  if (rubric.icRoleCap < 0 || rubric.icRoleCap > 10) {
    throw new Error(`icRoleCap must be between 0 and 10; got ${rubric.icRoleCap}.`);
  }
  if (rubric.alertThreshold < 0 || rubric.alertThreshold > 10) {
    throw new Error(`alertThreshold must be between 0 and 10; got ${rubric.alertThreshold}.`);
  }
}

// Build a human-readable rubric block to inject into the user message
// of every scoring call. The model needs to know the anchors to score
// each dimension consistently; embedding the rubric in the prompt is
// the lowest-magic way to keep "what's a 7?" in sync with the code.
export function formatRubricForPrompt(rubric: ScoringRubric): string {
  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(rubric.dimensions)) {
    const pct = Math.round(cfg.weight * 100);
    lines.push(`${name} match (${pct}% weight):`);
    lines.push(`  ${cfg.scale.description}`);
    for (const a of cfg.scale.anchors) {
      lines.push(`  - ${a.score.toFixed(1)}: ${a.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

validateRubric(DEFAULT_RUBRIC);
