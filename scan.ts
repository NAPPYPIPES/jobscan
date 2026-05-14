// Thin CLI wrapper. The scan logic + DB persistence live in lib/scan/ and
// db/, shared with app/api/cron/scan/route.ts. Running `npm run scan` is
// equivalent to hitting that API route locally.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { runScanAndPersist } from "./lib/scan/run";

async function main() {
  const summary = await runScanAndPersist();

  const t = summary.totals;
  const newSuffix = summary.isBaseline
    ? "(baseline run, 0 new by design)"
    : `${summary.totalNew} new since last scan`;

  console.log(
    `\nScanned ${summary.scannedCount}/${summary.targetCount} companies. ` +
      `${summary.totalRoles} total roles matched (${t.BV} BV, ${t.HIGH} HIGH, ${t.MEDIUM} MED, ${t.LOW} LOW) ` +
      `out of ${summary.totalJobs} total jobs. ${newSuffix}.`,
  );
  console.log(`Persisted ${summary.totalRoles} matches to Postgres.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
