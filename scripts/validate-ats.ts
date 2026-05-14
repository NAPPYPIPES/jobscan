// Pings every targets-table slug to confirm the ATS endpoint responds
// and returns at least one job. Catches typo'd slugs, deleted job
// boards, and ATS migrations before they silently leave a company
// unscanned.
//
// Usage:
//   npm run validate-ats
//
// Reads targets from the DB (`targets` table) and the Workday config
// from `workday_tenants`. Both must already be populated — run
// `npm run ingest-config` first if you've just installed the schema.
//
// Exit code is 0 if every slug returns 200 with > 0 jobs, 1 otherwise.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { ashbyUrl, greenhouseUrl, leverUrl } from "../lib/scan/fetch";
import { workdayApiUrl } from "../db/workday-tenants";
import { getTargets } from "../db/targets";
import type { Target } from "../db/schema";

type Result = {
  slug: string;
  displayName: string;
  ats: string;
  status: "ok" | "fail";
  count: number;
  note: string;
};

async function checkOne(t: Target): Promise<Result> {
  const base: Result = {
    slug: t.slug,
    displayName: t.displayName,
    ats: t.ats,
    status: "fail",
    count: 0,
    note: "",
  };
  try {
    if (t.ats === "greenhouse") {
      const res = await fetch(greenhouseUrl(t.slug));
      if (!res.ok) return { ...base, note: `HTTP ${res.status}` };
      const data = (await res.json()) as { jobs?: unknown[] };
      const count = data.jobs?.length ?? 0;
      return { ...base, status: count > 0 ? "ok" : "fail", count, note: count > 0 ? "" : "0 jobs returned" };
    }
    if (t.ats === "ashby") {
      const res = await fetch(ashbyUrl(t.slug));
      if (!res.ok) return { ...base, note: `HTTP ${res.status}` };
      const data = (await res.json()) as { jobs?: unknown[] };
      const count = data.jobs?.length ?? 0;
      return { ...base, status: count > 0 ? "ok" : "fail", count, note: count > 0 ? "" : "0 jobs returned" };
    }
    if (t.ats === "lever") {
      const res = await fetch(leverUrl(t.slug));
      if (!res.ok) return { ...base, note: `HTTP ${res.status}` };
      const data = (await res.json()) as unknown[];
      const count = Array.isArray(data) ? data.length : 0;
      return { ...base, status: count > 0 ? "ok" : "fail", count, note: count > 0 ? "" : "0 jobs returned" };
    }
    if (t.ats === "workday") {
      const url = await workdayApiUrl(t.slug);
      if (!url) return { ...base, note: "no workday-tenants row for this slug" };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
      });
      if (!res.ok) return { ...base, note: `HTTP ${res.status}` };
      const data = (await res.json()) as { total?: number };
      const count = data.total ?? 0;
      return { ...base, status: count > 0 ? "ok" : "fail", count, note: count > 0 ? "" : "0 jobs returned" };
    }
  } catch (err) {
    return { ...base, note: err instanceof Error ? err.message : String(err) };
  }
  return { ...base, note: "unknown ats" };
}

async function main() {
  const targets = await getTargets();
  if (targets.length === 0) {
    console.error(
      "targets table is empty — run `npm run ingest-config` to seed it before validating.",
    );
    process.exit(1);
  }
  console.log(`Validating ${targets.length} target slugs…\n`);
  const results = await Promise.all(targets.map(checkOne));

  const w = {
    slug: Math.max(8, ...results.map((r) => r.slug.length)),
    name: Math.max(8, ...results.map((r) => r.displayName.length)),
    ats: Math.max(3, ...results.map((r) => r.ats.length)),
  };
  for (const r of results) {
    const marker = r.status === "ok" ? "✓" : "✗";
    console.log(
      `${marker} ${r.slug.padEnd(w.slug)}  ${r.displayName.padEnd(w.name)}  ${r.ats.padEnd(w.ats)}  ${String(r.count).padStart(5)} jobs  ${r.note}`,
    );
  }

  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${results.length - failed.length}/${results.length} slugs returned jobs.`);
  if (failed.length > 0) {
    console.log(`\n${failed.length} slug${failed.length === 1 ? "" : "s"} need attention:`);
    for (const r of failed) {
      console.log(`  - ${r.slug} (${r.ats}): ${r.note || "no jobs"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("validate-ats failed:", err);
  process.exit(1);
});
