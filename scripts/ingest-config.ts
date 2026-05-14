// One-shot ingestion: reads config/<name>.json (or .example.json
// fallback) and writes each into its corresponding DB table.
// Replaces the previous module-load file-reader pattern; now the
// running app reads only from DB.
//
// Usage:
//   npm run ingest-config              # all four
//   npm run ingest-config -- targets   # just one
//
// Idempotent: every write is a transactional DELETE + INSERT, so
// running this multiple times produces the same end state.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { replaceTargets } from "../db/targets";
import {
  replaceManualCompanies,
  type ManualCompany,
} from "../db/manual-companies";
import { replaceWorkdayTenants } from "../db/workday-tenants";
import { replacePersonalKeywords } from "../db/personal-keywords";

const KINDS = ["targets", "manual-companies", "workday-tenants", "personal-keywords"] as const;
type Kind = (typeof KINDS)[number];

// For backwards compat with the old filename — the prior layout used
// "manual-targets.json" / "manual-targets.example.json". If the new
// "manual-companies.json" doesn't exist, fall back to the old name.
const FALLBACK_FILENAMES: Partial<Record<Kind, string>> = {
  "manual-companies": "manual-targets",
};

function loadJson<T>(kind: Kind): { source: "local" | "example"; data: T } {
  const root = process.cwd();
  const candidates: Array<{ source: "local" | "example"; filename: string }> = [
    { source: "local", filename: `${kind}.json` },
    { source: "example", filename: `${kind}.example.json` },
  ];
  const fallback = FALLBACK_FILENAMES[kind];
  if (fallback) {
    candidates.push({ source: "local", filename: `${fallback}.json` });
    candidates.push({ source: "example", filename: `${fallback}.example.json` });
  }
  for (const { source, filename } of candidates) {
    const filepath = path.join(root, "config", filename);
    if (existsSync(filepath)) {
      const data = JSON.parse(readFileSync(filepath, "utf8")) as T;
      return { source, data };
    }
  }
  throw new Error(
    `No config file found for "${kind}" — expected config/${kind}.json or config/${kind}.example.json`,
  );
}

async function ingestTargets() {
  const { source, data } = loadJson<Array<{
    ats: string;
    slug: string;
    displayName: string;
    sector?: string;
    stage?: string;
  }>>("targets");
  if (!Array.isArray(data)) {
    throw new Error("targets config must be a JSON array");
  }
  const rows = data.map((r) => {
    if (!r.slug || !r.ats || !r.displayName) {
      throw new Error(
        `targets: row missing required field (slug/ats/displayName): ${JSON.stringify(r)}`,
      );
    }
    return {
      slug: r.slug,
      ats: r.ats as "greenhouse" | "ashby" | "lever" | "workday",
      displayName: r.displayName,
      sector: (r.sector ?? null) as "tech" | "finserv" | "other" | null,
      stage: (r.stage ?? null) as
        | "public_enterprise" | "partnership" | "late_stage"
        | "growth" | "early" | "pe_owned" | "large_financial" | null,
    };
  });
  const inserted = await replaceTargets(rows);
  console.log(`[targets] ${inserted.length} rows written (source: ${source})`);
}

async function ingestManualCompanies() {
  const { source, data } = loadJson<ManualCompany[]>("manual-companies");
  if (!Array.isArray(data)) {
    throw new Error("manual-companies config must be a JSON array");
  }
  for (const r of data) {
    if (!r.name || !r.careersUrl || !r.description || !r.sector) {
      throw new Error(
        `manual-companies: row missing required field: ${JSON.stringify(r)}`,
      );
    }
  }
  const inserted = await replaceManualCompanies(data);
  console.log(`[manual-companies] ${inserted.length} rows written (source: ${source})`);
}

async function ingestWorkdayTenants() {
  // Stored as a slug → {host, board} object in JSON for ergonomics,
  // converted to row array for the writer.
  const { source, data } = loadJson<Record<string, { host: string; board: string }>>(
    "workday-tenants",
  );
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("workday-tenants config must be a JSON object");
  }
  const rows = Object.entries(data).map(([slug, cfg]) => {
    if (!cfg.host || !cfg.board) {
      throw new Error(`workday-tenants: "${slug}" missing host or board`);
    }
    return { slug, host: cfg.host, board: cfg.board };
  });
  const inserted = await replaceWorkdayTenants(rows);
  console.log(`[workday-tenants] ${inserted.length} rows written (source: ${source})`);
}

async function ingestPersonalKeywords() {
  const { source, data } = loadJson<{
    bv_phrases?: string[];
    healthcare_skips?: string[];
    hard_cap_low_patterns?: string[];
    finserv_bonus_positive_patterns?: string[];
    // Ignored, present in the example file as a docstring.
    _comment?: string;
  }>("personal-keywords");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("personal-keywords config must be a JSON object");
  }
  await replacePersonalKeywords({
    bvPhrases: data.bv_phrases ?? [],
    healthcareSkips: data.healthcare_skips ?? [],
    hardCapLowPatterns: data.hard_cap_low_patterns ?? [],
    finservBonusPositivePatterns: data.finserv_bonus_positive_patterns ?? [],
  });
  console.log(
    `[personal-keywords] 1 row written (source: ${source}) — ` +
      `${(data.bv_phrases ?? []).length} bv, ` +
      `${(data.healthcare_skips ?? []).length} healthcare, ` +
      `${(data.hard_cap_low_patterns ?? []).length} hardcap, ` +
      `${(data.finserv_bonus_positive_patterns ?? []).length} finserv-bonus`,
  );
}

const INGESTORS: Record<Kind, () => Promise<void>> = {
  targets: ingestTargets,
  "manual-companies": ingestManualCompanies,
  "workday-tenants": ingestWorkdayTenants,
  "personal-keywords": ingestPersonalKeywords,
};

async function main() {
  // Allow targeting a single kind: `npm run ingest-config -- targets`
  const arg = process.argv[2];
  const selected: Kind[] = arg
    ? (KINDS.includes(arg as Kind) ? [arg as Kind] : [])
    : [...KINDS];

  if (selected.length === 0) {
    console.error(
      `Unknown ingestion target "${arg}". Valid: ${KINDS.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Ingesting: ${selected.join(", ")}\n`);
  for (const kind of selected) {
    await INGESTORS[kind]();
  }
  console.log(`\nDone. App will read these on next request (module cache resets per cold start).`);
}

main().catch((err) => {
  console.error("[ingest-config] failed:", err);
  process.exit(1);
});
