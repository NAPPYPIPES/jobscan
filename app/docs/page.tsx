import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { apiUsage, matches } from "@/db/schema";
import { getTargets } from "@/db/targets";
import { getManualCompanies } from "@/db/manual-companies";
import { getViewerRole } from "@/lib/auth/viewer";
import { DEMO_SLUGS_ARRAY } from "@/lib/auth/demo-allowlist";
import type { Sector } from "@/lib/scan/types";
import { DEFAULT_RUBRIC } from "@/lib/fit/rubric";
import type { Level } from "@/lib/scan/types";
import { DailySpendChart, type DailySpendRow } from "./daily-spend-chart";
import TargetsTable, { type TargetRow } from "./targets-table";
import { ScoringCapsEditor } from "./scoring-caps-editor";
import { getScoringCaps } from "@/db/scoring-caps";
import { checkSpend } from "@/lib/fit/spendCaps";

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
  const viewerRole = await getViewerRole();
  const isDemo = viewerRole === "demo";
  const demoSlugFilter = isDemo
    ? [inArray(matches.companySlug, DEMO_SLUGS_ARRAY as string[])]
    : [];

  // Pre-fetch targets + manual list + scoring caps + spend status from
  // DB. All cached in their respective db/* modules so this is sub-ms
  // on warm requests. Demo viewers see the curated targets subset;
  // manual list is the same for both. Caps are read-only for demo.
  const [
    targets,
    manualCompanies,
    scoringCaps,
    triageSpend,
    scoreSpend,
    summarySpend,
  ] = await Promise.all([
    getTargets({ role: viewerRole }),
    getManualCompanies(),
    getScoringCaps(),
    checkSpend("triage"),
    checkSpend("score"),
    checkSpend("summary"),
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
    .where(
      and(
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
        ...demoSlugFilter,
      ),
    )
    .groupBy(matches.companySlug);
  const slugStats = new Map(perSlug.map((r) => [r.companySlug, r]));

  // ─── API spend (owner-only — skipped entirely in demo mode) ───────
  // Demo viewers must not see the owner's actual API spending. The
  // queries are skipped (no DB roundtrip) and the rendered section
  // is gated on !isDemo below.
  type RecentCallRow = {
    calledAt: Date;
    tokensIn: number;
    tokensOut: number;
    costUsd: string;
    model: string;
    purpose: string;
    title: string | null;
    companyDisplayName: string | null;
    fitScore: string | null;
  };
  let mtdSpend = 0;
  let dailySpend: DailySpendRow[] = [];
  let recentCalls: RecentCallRow[] = [];
  if (!isDemo) {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const spendRows = await db
      .select({ total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text` })
      .from(apiUsage)
      .where(gte(apiUsage.calledAt, start));
    mtdSpend = parseFloat(spendRows[0]?.total ?? "0");

    const dailySpendRows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text`,
      })
      .from(apiUsage)
      .where(gte(apiUsage.calledAt, sql`now() - interval '90 days'`))
      .groupBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`)
      .orderBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`);
    dailySpend = dailySpendRows.map((r) => ({
      date: r.date,
      spendUsd: parseFloat(r.total),
    }));

    recentCalls = await db
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
  }

  // Scanner stats — totals + per-level breakdown. Closed rows
  // excluded so "Total open" matches what /all actually displays.
  // Demo viewers see the same KPIs but scoped to their allowlist.
  const totalsRows = await db
    .select({
      total: sql<number>`count(*)::int`,
      scored: sql<number>`count(${matches.fitScore})::int`,
    })
    .from(matches)
    .where(
      and(
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
        ...demoSlugFilter,
      ),
    );
  const total = totalsRows[0]?.total ?? 0;
  const scoredCount = totalsRows[0]?.scored ?? 0;

  const byLevelRows = await db
    .select({
      level: matches.level,
      count: sql<number>`count(*)::int`,
    })
    .from(matches)
    .where(
      and(
        ne(matches.status, "dismissed"),
        isNull(matches.closedAt),
        ...demoSlugFilter,
      ),
    )
    .groupBy(matches.level);
  const byLevel: Record<Level, number> = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of byLevelRows) byLevel[r.level as Level] = r.count;

  const lastScanRows = await db
    .select({ ts: sql<string | null>`max(${matches.lastSeen})` })
    .from(matches)
    .where(isDemo ? and(...demoSlugFilter) : undefined);
  const lastScan = lastScanRows[0]?.ts;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Documentation
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          Sources &amp; methodology
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-fg-muted">
          Reference appendix — what the scanner is doing, how scoring works,
          and where the dollars are going.
        </p>
      </div>

      <Section title="Target companies">
        <p className="mb-4 text-sm text-fg-muted">
          <span className="font-mono tabular-nums text-fg">{targets.length}</span> target companies across {Object.keys(ATS_LABEL).length} ATS
          platforms. Hourly scan via the cron route; results live at the URLs
          built per-tenant from each ATS&rsquo;s public job-board API. These
          feed{" "}
          <a
            href="/"
            className="font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg-subtle"
          >
            Recent
          </a>
          {", "}
          <a
            href="/all"
            className="font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg-subtle"
          >
            All open
          </a>
          , and the daily digest. Edit{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-fg">
            lib/scan/targets.ts
          </code>{" "}
          to add or remove.
        </p>
        <TargetsTable
          rows={targets.map((t): TargetRow => {
            const stats = slugStats.get(t.slug);
            return {
              slug: t.slug,
              ats: t.ats,
              displayName: t.displayName,
              sector: sectorForSlug(t.slug),
              count: stats?.count ?? 0,
              lastSeenIso: stats?.lastSeen ?? null,
            };
          })}
        />
      </Section>

      <Section title="Manual checklist companies">
        <p className="mb-4 text-sm text-fg-muted">
          <span className="font-mono tabular-nums text-fg">{manualCompanies.length}</span> companies whose careers sites use custom
          ATSs that can&rsquo;t be scanned via public APIs. Not in the
          automated scan; visited daily on{" "}
          <a
            href="/manual"
            className="font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg-subtle"
          >
            /manual
          </a>
          . Edit{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-fg">
            lib/scan/manual-targets.ts
          </code>{" "}
          to change the list or tune the pre-filtered careers URLs.
        </p>
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
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
                  className="border-t border-line-subtle transition-colors hover:bg-muted"
                >
                  <td className="px-3 py-2 font-medium">
                    <a
                      href={m.careersUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg-subtle"
                    >
                      {m.name}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{m.sector}</td>
                  <td className="px-3 py-2 text-fg-subtle">{m.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Scoring rubric">
        <div className="rounded-lg border border-line bg-surface p-6 shadow-card">
          <p className="mb-4 text-sm text-fg-muted">
            Five dimensions, weighted average, rounded to one decimal. Claude
            produces the dimension scores; TypeScript computes the weighted
            average and applies the IC cap. Edit{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-fg">
              lib/fit/rubric.ts
            </code>{" "}
            to tune.
          </p>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Dimensions &amp; weights
          </h3>
          <ul className="mb-4 space-y-1 text-sm text-fg-muted">
            {Object.entries(DEFAULT_RUBRIC.dimensions).map(([name, cfg]) => (
              <li key={name}>
                • {name.charAt(0).toUpperCase() + name.slice(1)} match —{" "}
                <span className="font-mono font-semibold tabular-nums text-fg">
                  {Math.round(cfg.weight * 100)}%
                </span>
              </li>
            ))}
          </ul>

          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Caps and thresholds
          </h3>
          <ul className="space-y-1 text-sm text-fg-muted">
            <li>
              IC role cap:{" "}
              <span className="font-mono tabular-nums text-fg">{DEFAULT_RUBRIC.icRoleCap.toFixed(1)}</span>{" "}
              — individual-contributor sales roles can&rsquo;t score above
              this regardless of dimensions.
            </li>
            <li>
              Alert threshold:{" "}
              <span className="font-mono tabular-nums text-fg">{DEFAULT_RUBRIC.alertThreshold.toFixed(1)}</span>{" "}
              — minimum fit_score to appear in the daily digest.
            </li>
            <li>
              Hard exclusions:{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-fg">
                {DEFAULT_RUBRIC.hardExclusions.join(", ")}
              </code>{" "}
              — flags that force the overall score to 0.
            </li>
          </ul>
        </div>
      </Section>

      {!isDemo && (
      <Section title="API usage &amp; cost">
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
            <div className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              Month-to-date spend
            </div>
            <div className="mt-1 font-mono text-3xl font-semibold tabular-nums text-fg">
              ${mtdSpend.toFixed(2)}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
            <div className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
              Caps
            </div>
            <div className="mt-1 text-sm text-fg-muted">
              Soft warning at{" "}
              <span className="font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">$35</span>{" "}
              · hard stop at{" "}
              <span className="font-mono font-semibold tabular-nums text-rose-700 dark:text-rose-400">$40</span>
            </div>
            <div className="mt-1 text-xs text-fg-subtle">
              Edit caps in lib/fit/score.ts.
            </div>
          </div>
        </div>

        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          Last 20 calls
        </h3>
        {recentCalls.length === 0 ? (
          <div className="empty-state p-6 text-center">
            <p className="text-sm text-fg-subtle">No API calls yet.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-muted text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
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
                    className="border-t border-line-subtle transition-colors hover:bg-muted"
                  >
                    <td className="px-3 py-2 font-mono text-xs tabular-nums text-fg-subtle">
                      {shortDate(c.calledAt as unknown as Date)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                          c.purpose === "summary"
                            ? "bg-indigo-50 text-indigo-700 ring-indigo-200/70 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-400/20"
                            : "bg-muted text-fg-muted ring-line"
                        }`}
                      >
                        {c.purpose}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-fg">{c.title ?? "—"}</td>
                    <td className="px-3 py-2 text-fg-muted">
                      {c.companyDisplayName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                      {c.fitScore ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-subtle">
                      {c.tokensIn}+{c.tokensOut}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
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
      )}

      <Section title="Scanner stats">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Companies" value={targets.length} />
          <Kpi label="Total open" value={total} />
          <Kpi label="Scored" value={scoredCount} accent="text-emerald-700 dark:text-emerald-400" />
          <Kpi label="BV" value={byLevel.BV} accent="text-indigo-700 dark:text-indigo-400" />
          <Kpi label="HIGH" value={byLevel.HIGH} accent="text-rose-700 dark:text-rose-400" />
          <Kpi label="MED" value={byLevel.MEDIUM} accent="text-amber-700 dark:text-amber-400" />
        </div>
        <p className="mt-4 text-sm text-fg-muted">
          LOW: <span className="font-mono font-semibold tabular-nums text-fg">{byLevel.LOW}</span>.{" "}
          Last scan:{" "}
          <span className="font-mono tabular-nums text-fg">
            {longDate(lastScan as unknown as Date | null)}
          </span>
          .
        </p>
      </Section>

      <Section title="Scoring caps">
        <p className="mb-4 text-sm text-fg-muted">
          Per-day volume caps and monthly spend caps for the two-tier
          (Haiku → Sonnet) scoring funnel. Changes apply on the next
          scan tick. Spend resets at UTC month start.
        </p>
        <ScoringCapsEditor
          initial={scoringCaps}
          spend={{
            triage: {
              spent: triageSpend.spent,
              cap: scoringCaps.monthlyCapsUsd.triage,
            },
            score: {
              spent: scoreSpend.spent,
              cap: scoringCaps.monthlyCapsUsd.score,
            },
            summary: {
              spent: summarySpend.spent,
              cap: scoringCaps.monthlyCapsUsd.summary,
            },
            total: {
              spent: triageSpend.totalSpent,
              cap: scoringCaps.monthlyCapsUsd.total,
            },
          }}
          readOnly={isDemo}
        />
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
      <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
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
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${
          accent ?? "text-fg"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
