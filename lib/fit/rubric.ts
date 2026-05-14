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
    function: {
      weight: 0.30,
      scale: {
        description:
          "How closely the role's primary function matches the user's target_roles and functions.",
        anchors: [
          { score: 10, description: "Exact match for one of the user's top target roles." },
          { score: 8,  description: "Adjacent function in the same family (e.g. Head of Revenue when target is VP Sales)." },
          { score: 6,  description: "Same broad area, different specialty (e.g. Sales Ops when target is Sales leadership)." },
          { score: 4,  description: "Related but tangential (e.g. Customer Success when target is Sales)." },
          { score: 2,  description: "Different function in the same org type (e.g. Marketing when target is Sales)." },
          { score: 0,  description: "Outside the user's function entirely (e.g. Engineering when targets are GTM)." },
        ],
      },
    },
    seniority: {
      weight: 0.25,
      scale: {
        description:
          "How well the role's level matches the user's seniority_level and years_experience. Adjust downward if a posted YOE requirement is far below the user's experience (suggests an under-leveled role they'd be over-qualified for).",
        anchors: [
          { score: 10, description: "VP / SVP / C-suite — strong fit for a senior leader." },
          { score: 7,  description: "Director / Senior Director — strong fit for senior IC or first-line leader." },
          { score: 5,  description: "Manager / Lead / Senior IC — possible fit but below target seniority." },
          { score: 2,  description: "Mid-level IC (Senior + a function) — under-leveled for a 15+ year leader." },
          { score: 0,  description: "Entry-level / Associate / Analyst." },
        ],
      },
    },
    industry: {
      weight: 0.25,
      scale: {
        description:
          "How well the company's industry matches the user's industries. Score generously when the company description names a domain the user has worked in directly; score conservatively for adjacent-but-different buyer types (e.g. consumer B2C when the user is enterprise B2B).",
        anchors: [
          { score: 10, description: "Same industry as the user's strongest experience (direct domain expertise)." },
          { score: 8,  description: "Adjacent regulated/enterprise industry — transferable skills." },
          { score: 6,  description: "Different B2B industry, same buyer type." },
          { score: 4,  description: "B2C or developer-tool when the user's background is enterprise B2B." },
          { score: 2,  description: "Industry on the user's hard_exclusions list (also set the corresponding flag)." },
        ],
      },
    },
    stage: {
      weight: 0.10,
      scale: {
        description:
          "Company funding/maturity stage fit. Defaults assume the user prefers high-leverage growth-stage opportunities; flip the anchors if you'd rather optimize for public-company stability.",
        anchors: [
          { score: 10, description: "Series B / C / D — high-leverage growth stage." },
          { score: 9,  description: "Late-stage private or public enterprise." },
          { score: 6,  description: "PE-owned or unknown stage." },
          { score: 4,  description: "Series A — early but viable." },
          { score: 2,  description: "Seed / pre-seed — likely too early for senior IC + management." },
        ],
      },
    },
    location: {
      weight: 0.10,
      scale: {
        description:
          "Geographic fit against the user's stated location constraints (encoded in the system prompt from their resume).",
        anchors: [
          { score: 10, description: "User's home metro OR remote in user's country." },
          { score: 7,  description: "Hybrid with user's metro listed as one option." },
          { score: 4,  description: "Single different city (requires relocation)." },
          { score: 0,  description: "International only / requires relocation outside user's country." },
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
