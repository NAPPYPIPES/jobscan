import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, matches } from "@/db/schema";
import { getTargets } from "@/db/targets";
import { getManualCompanies } from "@/db/manual-companies";
import type { Sector } from "@/lib/scan/types";
import { DEFAULT_RUBRIC } from "@/lib/fit/rubric";
import type { Level } from "@/lib/scan/types";
import { DailySpendChart, type DailySpendRow } from "./daily-spend-chart";

export const dynamic = "force-dynamic";

const ATS_LABEL: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workday: "Workday",
};

function shortDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(d));
}

function longDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(d));
}

export default async function Docs() {
  const db = getDb();

  // Pre-fetch targets + manual list from DB. Both cached in their
  // respective db/* modules so this is sub-ms on warm requests.
  const [targets, manualCompanies] = await Promise.all([
    getTargets(),
    getManualCompanies(),
  ]);
  // Inline sector helper using the fetched rows — avoids touching the
  // db/targets module-level helper which would do a separate (cached)
  // round trip.
  const sectorByTargetSlug = new Map<string, Sector>(
    targets.map((t) => [t.slug, (t.sector ?? "tech") as Sector]),
  );
  const sectorForSlug = (slug: string): Sector =>
    sectorByTargetSlug.get(slug) ?? "tech";

  const perSlug = await db
    .select({
      companySlug: matches.companySlug,
      count: sql<number>`count(*)::int`,
      lastSeen: sql<string | null>`max(${matches.lastSeen})`,
    })
    .from(matches)
    .where(ne(matches.status, "dismissed"))
    .groupBy(matches.companySlug);
  const slugStats = new Map(perSlug.map((r) => [r.companySlug, r]));

  // Month-to-date API spend.
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const spendRows = await db
    .select({ total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text` })
    .from(apiUsage)
    .where(gte(apiUsage.calledAt, start));
  const mtdSpend = parseFloat(spendRows[0]?.total ?? "0");

  // Daily spend over the last 90 days.
  const dailySpendRows = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text`,
    })
    .from(apiUsage)
    .where(gte(apiUsage.calledAt, sql`now() - interval '90 days'`))
    .groupBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`)
    .orderBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`);
  const dailySpend: DailySpendRow[] = dailySpendRows.map((r) => ({
    date: r.date,
    spendUsd: parseFloat(r.total),
  }));

  // Last 20 API calls joined to matches for context.
  const recentCalls = await db
    .select({
      calledAt: apiUsage.calledAt,
      tokensIn: apiUsage.tokensIn,
      tokensOut: apiUsage.tokensOut,
      costUsd: apiUsage.costUsd,
      model: apiUsage.model,
      purpose: apiUsage.purpose,
      title: matches.title,
      companyDisplayName: matches.companyDisplayName,
      fitScore: matches.fitScore,
    })
    .from(apiUsage)
    .leftJoin(matches, eq(apiUsage.matchId, matches.id))
    .orderBy(desc(apiUsage.calledAt))
    .limit(20);

  // Scanner stats — totals + per-level breakdown.
  const totalsRows = await db
    .select({
      total: sql<number>`count(*)::int`,
      scored: sql<number>`count(${matches.fitScore})::int`,
    })
    .from(matches)
    .where(ne(matches.status, "dismissed"));
  const total = totalsRows[0]?.total ?? 0;
  const scoredCount = totalsRows[0]?.scored ?? 0;

  const byLevelRows = await db
    .select({
      level: matches.level,
      count: sql<number>`count(*)::int`,
    })
    .from(matches)
    .where(ne(matches.status, "dismissed"))
    .groupBy(matches.level);
  const byLevel: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of byLevelRows) byLevel[r.level as Level] = r.count;

  const lastScanRows = await db
    .select({ ts: sql<string | null>`max(${matches.lastSeen})` })
    .from(matches);
  const lastScan = lastScanRows[0]?.ts;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-stone-400">
          Documentation
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
          Sources &amp; methodology
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-stone-500">
          Reference appendix — what the scanner is doing, how scoring works,
          and where the dollars are going.
        </p>
      </div>

      <Section title="Target companies">
        <p className="mb-4 text-sm text-stone-600">
          {targets.length} target companies across {Object.keys(ATS_LABEL).length} ATS
          platforms. Hourly scan via the cron route; results live at the URLs
          built per-tenant from each ATS&rsquo;s public job-board API. These
          feed{" "}
          <a
            href="/"
            className="font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600"
          >
            Recent
          </a>
          {", "}
          <a
            href="/all"
            className="font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600"
          >
            All open
          </a>
          , and the daily digest. Edit{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px] text-stone-700">
            lib/scan/targets.ts
          </code>{" "}
          to add or remove.
        </p>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-[10px] font-medium uppercase tracking-wider text-stone-500">
              <tr>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">ATS</th>
                <th className="px-3 py-2 text-left">Slug</th>
                <th className="px-3 py-2 text-left">Sector</th>
                <th className="px-3 py-2 text-right">Open roles</th>
                <th className="px-3 py-2 text-left">Last scan</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...targets]
                .sort((a, b) =>
                  a.displayName.localeCompare(b.displayName, "en", {
                    sensitivity: "base",
                  }),
                )
                .map((t) => {
                  const stats = slugStats.get(t.slug);
                  const count = stats?.count ?? 0;
                  const last = stats?.lastSeen ? new Date(stats.lastSeen) : null;
                  const status = count > 0 ? "Active" : "No roles found";
                  const sector = sectorForSlug(t.slug);
                  return (
                    <tr
                      key={t.slug}
                      className="border-t border-stone-100 hover:bg-stone-50"
                    >
                      <td className="px-3 py-2 font-medium text-stone-900">
                        {t.displayName}
                      </td>
                      <td className="px-3 py-2 text-stone-600">{ATS_LABEL[t.ats]}</td>
                      <td className="px-3 py-2 font-mono text-xs text-stone-500">
                        {t.slug}
                      </td>
                      <td className="px-3 py-2 text-stone-600">{sector}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-stone-700">
                        {count}
                      </td>
                      <td className="px-3 py-2 text-stone-500">{shortDate(last)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            count > 0
                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70"
                              : "bg-stone-100 text-stone-500 ring-1 ring-inset ring-stone-200"
                          }`}
                        >
                          {status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Manual checklist companies">
        <p className="mb-4 text-sm text-stone-600">
          {manualCompanies.length} companies whose careers sites use custom
          ATSs that can&rsquo;t be scanned via public APIs. Not in the
          automated scan; visited daily on{" "}
          <a
            href="/manual"
            className="font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600"
          >
            /manual
          </a>
          . Edit{" "}
          <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px] text-stone-700">
            lib/scan/manual-targets.ts
          </code>{" "}
          to change the list or tune the pre-filtered careers URLs.
        </p>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-[10px] font-medium uppercase tracking-wider text-stone-500">
              <tr>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Sector</th>
                <th className="px-3 py-2 text-left">Note</th>
              </tr>
            </thead>
            <tbody>
              {manualCompanies.map((m) => (
                <tr
                  key={m.name}
                  className="border-t border-stone-100 hover:bg-stone-50"
                >
                  <td className="px-3 py-2 font-medium">
                    <a
                      href={m.careersUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-stone-900 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600"
                    >
                      {m.name}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-stone-600">{m.sector}</td>
                  <td className="px-3 py-2 text-stone-500">{m.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Scoring rubric">
        <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <p className="mb-4 text-sm text-stone-600">
            Five dimensions, weighted average, rounded to one decimal. Claude
            produces the dimension scores; TypeScript computes the weighted
            average and applies the IC cap. Edit{" "}
            <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px] text-stone-700">
              lib/fit/rubric.ts
            </code>{" "}
            to tune.
          </p>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
            Dimensions &amp; weights
          </h3>
          <ul className="mb-4 space-y-1 text-sm text-stone-700">
            {Object.entries(DEFAULT_RUBRIC.dimensions).map(([name, cfg]) => (
              <li key={name}>
                • {name.charAt(0).toUpperCase() + name.slice(1)} match —{" "}
                <span className="font-semibold">
                  {Math.round(cfg.weight * 100)}%
                </span>
              </li>
            ))}
          </ul>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
            Caps and thresholds
          </h3>
          <ul className="space-y-1 text-sm text-stone-700">
            <li>
              IC role cap:{" "}
              <span className="font-mono">{DEFAULT_RUBRIC.icRoleCap.toFixed(1)}</span>{" "}
              — individual-contributor sales roles can&rsquo;t score above
              this regardless of dimensions.
            </li>
            <li>
              Alert threshold:{" "}
              <span className="font-mono">{DEFAULT_RUBRIC.alertThreshold.toFixed(1)}</span>{" "}
              — minimum fit_score to appear in the daily digest.
            </li>
            <li>
              Hard exclusions:{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 text-[12px] text-stone-700">
                {DEFAULT_RUBRIC.hardExclusions.join(", ")}
              </code>{" "}
              — flags that force the overall score to 0.
            </li>
          </ul>
        </div>
      </Section>

      <Section title="API usage &amp; cost">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-stone-400">
              Month-to-date spend
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-stone-900">
              ${mtdSpend.toFixed(2)}
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-stone-400">
              Caps
            </div>
            <div className="mt-1 text-sm text-stone-700">
              Soft warning at{" "}
              <span className="font-mono font-semibold text-amber-700">$35</span>{" "}
              · hard stop at{" "}
              <span className="font-mono font-semibold text-rose-700">$40</span>
            </div>
            <div className="mt-1 text-xs text-stone-400">
              Edit caps in lib/fit/score.ts.
            </div>
          </div>
        </div>

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
          Last 20 calls
        </h3>
        {recentCalls.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white/40 p-6 text-center">
            <p className="text-sm text-stone-500">No API calls yet.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-[10px] font-medium uppercase tracking-wider text-stone-500">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Purpose</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right">Tokens</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((c, i) => (
                  <tr
                    key={i}
                    className="border-t border-stone-100 hover:bg-stone-50"
                  >
                    <td className="px-3 py-2 text-stone-500">
                      {shortDate(c.calledAt as unknown as Date)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                          c.purpose === "summary"
                            ? "bg-indigo-50 text-indigo-700 ring-indigo-200/70"
                            : "bg-stone-100 text-stone-600 ring-stone-200"
                        }`}
                      >
                        {c.purpose}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-stone-800">{c.title ?? "—"}</td>
                    <td className="px-3 py-2 text-stone-600">
                      {c.companyDisplayName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-700">
                      {c.fitScore ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-500">
                      {c.tokensIn}+{c.tokensOut}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-stone-700">
                      ${parseFloat(c.costUsd).toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4">
          <DailySpendChart data={dailySpend} />
        </div>
      </Section>

      <Section title="Scanner stats">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Companies" value={targets.length} />
          <Kpi label="Total open" value={total} />
          <Kpi label="Scored" value={scoredCount} accent="text-emerald-700" />
          <Kpi label="BV" value={byLevel.BV} accent="text-indigo-700" />
          <Kpi label="HIGH" value={byLevel.HIGH} accent="text-rose-700" />
          <Kpi label="MED" value={byLevel.MEDIUM} accent="text-amber-700" />
        </div>
        <p className="mt-4 text-sm text-stone-600">
          LOW: <span className="font-medium text-stone-900">{byLevel.LOW}</span>.{" "}
          Last scan:{" "}
          <span className="font-medium text-stone-900">
            {longDate(lastScan as unknown as Date | null)}
          </span>
          .
        </p>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-sm font-semibold tracking-tight text-stone-700">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-stone-400">
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          accent ?? "text-stone-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
