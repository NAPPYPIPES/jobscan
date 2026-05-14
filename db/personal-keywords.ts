import { desc, sql } from "drizzle-orm";
import { getDb } from "./client";
import { personalKeywords } from "./schema";

// Classifier vocabulary loaded from DB. Regex fields are stored as
// arrays of source strings (JSONB), compiled to RegExp here. A bad
// pattern is warned + dropped rather than crashing the whole filter
// module at load time.
export type LoadedPersonalKeywords = {
  bvPhrases: string[];
  healthcareSkips: string[];
  hardCapLowPatterns: RegExp[];
  finservBonusPositivePatterns: RegExp[];
};

// Empty defaults used when the personal_keywords table has no rows
// (forker has run drizzle-kit push but not ingest-config yet, or has
// deliberately blanked the keywords). All classifications still work
// — they just don't get the personal-touch enhancements.
export const EMPTY_KEYWORDS: LoadedPersonalKeywords = {
  bvPhrases: [],
  healthcareSkips: [],
  hardCapLowPatterns: [],
  finservBonusPositivePatterns: [],
};

let cached: LoadedPersonalKeywords | null = null;

function compileRegexes(name: string, sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src));
    } catch (err) {
      console.warn(`[personal-keywords] bad regex in ${name}: ${JSON.stringify(src)} —`, err);
    }
  }
  return out;
}

async function loadFresh(): Promise<LoadedPersonalKeywords> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personalKeywords)
    .orderBy(desc(personalKeywords.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return EMPTY_KEYWORDS;
  return {
    bvPhrases: row.bvPhrases ?? [],
    healthcareSkips: row.healthcareSkips ?? [],
    hardCapLowPatterns: compileRegexes(
      "hard_cap_low_patterns",
      row.hardCapLowPatterns ?? [],
    ),
    finservBonusPositivePatterns: compileRegexes(
      "finserv_bonus_positive_patterns",
      row.finservBonusPositivePatterns ?? [],
    ),
  };
}

// Fetch the single personal_keywords row, with regexes pre-compiled.
// Returns EMPTY_KEYWORDS if the table is empty — the scan and classifier
// continue working in that state, just without personal enhancements.
export async function getPersonalKeywords(): Promise<LoadedPersonalKeywords> {
  if (cached) return cached;
  cached = await loadFresh();
  return cached;
}

// Replace the single personal_keywords row.
//
// neon-http doesn't support multi-statement transactions, so we
// INSERT the new row first (with a fresh uuid PK, no conflict) then
// DELETE everything else. Brief window where two rows coexist;
// getPersonalKeywords reads `ORDER BY updated_at DESC LIMIT 1` so the
// returned value is always the freshest. Worst-case interruption
// leaves two rows — harmless, just a stale cleanup step.
//
// Regex fields take SOURCE STRINGS, not compiled RegExp — same shape
// as what's in config/personal-keywords.example.json.
export async function replacePersonalKeywords(row: {
  bvPhrases: string[];
  healthcareSkips: string[];
  hardCapLowPatterns: string[];
  finservBonusPositivePatterns: string[];
}): Promise<LoadedPersonalKeywords> {
  const db = getDb();
  const inserted = await db
    .insert(personalKeywords)
    .values({
      bvPhrases: row.bvPhrases,
      healthcareSkips: row.healthcareSkips,
      hardCapLowPatterns: row.hardCapLowPatterns,
      finservBonusPositivePatterns: row.finservBonusPositivePatterns,
      updatedAt: sql`now()`,
    })
    .returning({ id: personalKeywords.id });
  const newId = inserted[0]?.id;
  if (newId) {
    await db.delete(personalKeywords).where(sql`id <> ${newId}`);
  }
  cached = {
    bvPhrases: row.bvPhrases,
    healthcareSkips: row.healthcareSkips,
    hardCapLowPatterns: compileRegexes("hard_cap_low_patterns", row.hardCapLowPatterns),
    finservBonusPositivePatterns: compileRegexes(
      "finserv_bonus_positive_patterns",
      row.finservBonusPositivePatterns,
    ),
  };
  return cached;
}
