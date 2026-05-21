import { and, asc, desc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { apiUsage, matches, targets, userMatches, type Match } from "@/db/schema";
import { jobUrl } from "@/lib/scan/urls";
import type { Level } from "@/lib/scan/types";
import { getViewerRole, getViewerUserId } from "@/lib/auth/viewer";
import TopCompaniesList, {
  type CompanyData,
} from "../_components/top-companies-list";
import CompactRow from "../_components/compact-row";
import { DailySpendChart, type DailySpendRow } from "../docs/daily-spend-chart";
import {
  DailyNewJobsChart,
  type DailyNewJobsRow,
} from "./daily-new-jobs-chart";
import {
  JobsByCompany,
  JobsByFit,
  JobsByLevel,
  type NewRolesByCompany,
  type NewRolesByFitBand,
  type NewRolesByLevel,
} from "./trends";
import ClosedRoles, { type ClosedRow } from "./closed-roles";
import ScanFailures, { type FailingTarget } from "./scan-failures";

export const dynamic = "force-dynamic";

// Threshold for "currently failing" target detection. A target whose
// last_success_at lags the most recent successful scan by more than
// this is flagged. 90 min = one full hourly cycle missed plus buffer.
const SCAN_STALE_THRESHOLD_MINUTES = 90;

export default async function Analytics() {
  const userId = await getViewerUserId();
  if (!userId) redirect("/login");
  const db = getDb();
  const viewerRole = await getViewerRole();
  const isDemo = viewerRole === "demo";

  // Phase 4: every match-derived aggregate joins user_matches and
  // scopes to the viewer's user_id. The demo user has its own
  // pre-seeded user_matches subset (see migration 0006), so we no
  // longer slap a DEMO_SLUGS filter on every query — the join does it.

  // ─── Activity (last 72h) — three trend widgets ─────────────────────
  const since72hSql = sql`now() - interval '72 hours'`;
  const since48hSql = sql`now() - interval '48 hours'`;
  const since24hSql = sql`now() - interval '24 hours'`;

  const byLevelWindowRows = await db
    .select({
      level: userMatches.level,
      h24: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since24hSql})::int`,
      h48: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since48hSql})::int`,
      h72: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since72hSql})::int`,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        gte(matches.firstSeen, since72hSql),
        ne(userMatches.status, "dismissed"),
        eq(userMatches.isBaseline, false),
        isNull(matches.closedAt),
      ),
    )
    .groupBy(userMatches.level);
  const newRolesByLevel: NewRolesByLevel = {
    BV: { h24: 0, h48: 0, h72: 0 },
    HIGH: { h24: 0, h48: 0, h72: 0 },
    MEDIUM: { h24: 0, h48: 0, h72: 0 },
    LOW: { h24: 0, h48: 0, h72: 0 },
  };
  for (const r of byLevelWindowRows) {
    newRolesByLevel[r.level as Level] = { h24: r.h24, h48: r.h48, h72: r.h72 };
  }

  // Fit band query — 24h slice, bucket by fit_score. Per-user via
  // join. Drizzle's raw sql template lets us keep the CASE-based
  // bucketing as a single statement.
  const byFitBandRows = await db.execute(
    sql`SELECT
      CASE
        WHEN um.fit_score IS NULL THEN 'unscored'
        WHEN um.fit_score >= 8.0 THEN 'high'
        WHEN um.fit_score >= 6.0 THEN 'good'
        ELSE 'low'
      END AS band,
      count(*)::int AS count
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND m.first_seen >= now() - interval '24 hours'
      AND um.status != 'dismissed'
      AND um.is_baseline = false
      AND m.closed_at IS NULL
    GROUP BY band`,
  );
  const newRolesByFit: NewRolesByFitBand = {
    high: 0,
    good: 0,
    low: 0,
    unscored: 0,
  };
  for (const r of byFitBandRows.rows as { band: string; count: number }[]) {
    if (r.band === "high" || r.band === "good" || r.band === "low" || r.band === "unscored") {
      newRolesByFit[r.band] = r.count;
    }
  }

  const byCompanyWindowRows = await db
    .select({
      slug: matches.companySlug,
      name: matches.companyDisplayName,
      h24: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since24hSql})::int`,
      h48: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since48hSql})::int`,
      h72: sql<number>`count(*) FILTER (WHERE ${matches.firstSeen} >= ${since72hSql})::int`,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        gte(matches.firstSeen, since72hSql),
        ne(userMatches.status, "dismissed"),
        eq(userMatches.isBaseline, false),
        isNull(matches.closedAt),
      ),
    )
    .groupBy(matches.companySlug, matches.companyDisplayName);
  const newRolesByCompany: NewRolesByCompany[] = byCompanyWindowRows.map((r) => ({
    slug: r.slug,
    name: r.name,
    h24: r.h24,
    h48: r.h48,
    h72: r.h72,
  }));

  // ─── Top 10 companies by open roles ─────────────────────────────────
  const perSlugLevel = await db
    .select({
      slug: matches.companySlug,
      name: matches.companyDisplayName,
      level: userMatches.level,
      count: sql<number>`count(*)::int`,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        ne(userMatches.status, "dismissed"),
        eq(userMatches.isBaseline, false),
        isNull(matches.closedAt),
      ),
    )
    .groupBy(matches.companySlug, matches.companyDisplayName, userMatches.level);
  const companyMap = new Map<string, CompanyData>();
  for (const r of perSlugLevel) {
    let entry = companyMap.get(r.slug);
    if (!entry) {
      entry = {
        slug: r.slug,
        name: r.name,
        byLevel: { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      };
      companyMap.set(r.slug, entry);
    }
    entry.byLevel[r.level as Level] = r.count;
  }
  const companies = Array.from(companyMap.values());

  // ─── Closed roles + per-target scan failures ───────────────────────
  // Closed rows are global — when matches.closed_at is set, the job
  // is gone for everyone. But we still want to scope the closed
  // count to roles the viewer was watching (joined via user_matches).
  const closedTotalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        ne(userMatches.status, "dismissed"),
        isNotNull(matches.closedAt),
      ),
    );
  const closedTotal = closedTotalRow[0]?.count ?? 0;

  const closedRows = await db
    .select({
      // Re-project to the shape Match expects so ClosedRoles' CompactRow
      // can render. Per-user state pulled from user_matches.
      id: matches.id,
      ats: matches.ats,
      companySlug: matches.companySlug,
      companyDisplayName: matches.companyDisplayName,
      jobId: matches.jobId,
      title: matches.title,
      location: matches.location,
      firstSeen: matches.firstSeen,
      lastSeen: matches.lastSeen,
      closedAt: matches.closedAt,
      createdAt: matches.createdAt,
      level: userMatches.level,
      status: userMatches.status,
      isBaseline: userMatches.isBaseline,
      appliedAt: userMatches.appliedAt,
      dismissedAt: userMatches.dismissedAt,
      dismissReason: userMatches.dismissReason,
      fitScore: userMatches.fitScore,
      fitSummary: userMatches.fitSummary,
      fitFlag: userMatches.fitFlag,
      tier1Score: userMatches.tier1Score,
      tier1Confidence: userMatches.tier1Confidence,
      tier1IsPotentialBv: userMatches.tier1IsPotentialBv,
      tier1QuickTake: userMatches.tier1QuickTake,
      pendingBvVerification: userMatches.pendingBvVerification,
      bvReasoning: userMatches.bvReasoning,
      updatedAt: userMatches.updatedAt,
    })
    .from(userMatches)
    .innerJoin(matches, eq(matches.id, userMatches.matchId))
    .where(
      and(
        eq(userMatches.userId, userId),
        ne(userMatches.status, "dismissed"),
        isNotNull(matches.closedAt),
      ),
    )
    .orderBy(desc(matches.closedAt))
    .limit(25);
  const closedWithUrls: ClosedRow[] = await Promise.all(
    closedRows.map(async (m) => ({
      m: m as ClosedRow["m"],
      applyUrl: await jobUrl(m.ats, m.companySlug, m.jobId),
    })),
  );

  // Failing-scan detection: a target is flagged if its
  // last_success_at is meaningfully older than the most recent
  // successful scan across all targets. Scoped to the viewer's
  // user_targets so demo sees only their curated set.
  const latestSuccessRow = await db
    .select({ ts: sql<string | null>`max(${targets.lastSuccessAt})` })
    .from(targets);
  const latestSuccessIso = latestSuccessRow[0]?.ts ?? null;

  const scanCutoffSql = sql`(SELECT max(${targets.lastSuccessAt}) FROM ${targets}) - interval '${sql.raw(
    String(SCAN_STALE_THRESHOLD_MINUTES),
  )} minutes'`;
  const failingRows = await db.execute(sql`
    SELECT t.slug, t.display_name, t.ats, t.last_success_at
    FROM targets t
    JOIN user_targets ut ON ut.target_slug = t.slug AND ut.user_id = ${userId}
    WHERE t.last_success_at IS NULL
       OR t.last_success_at < ${scanCutoffSql}
    ORDER BY t.last_success_at ASC NULLS FIRST
  `);
  const failingTargets: FailingTarget[] = (
    failingRows.rows as Array<{
      slug: string;
      display_name: string;
      ats: string;
      last_success_at: string | null;
    }>
  ).map((r) => ({
    slug: r.slug,
    displayName: r.display_name,
    ats: r.ats as FailingTarget["ats"],
    lastSuccessIso: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
  }));

  // ─── New jobs per day (scoped to the viewer's watchlist) ──────────
  // Pull matches.first_seen counts per UTC day for the last 90 days,
  // grouped by level so the chart can stack BV/HIGH/MEDIUM/LOW. Joined
  // through user_matches → the user's targets. Excludes baseline imports
  // (those are intentional bulk adds, not net-new discoveries). The
  // chart pads missing days/levels client-side.
  const dailyNewJobsRows = await db.execute(sql`
    SELECT
      to_char(date_trunc('day', m.first_seen at time zone 'UTC'), 'YYYY-MM-DD') AS date,
      um.level AS level,
      count(*)::int AS count
    FROM user_matches um
    JOIN matches m ON m.id = um.match_id
    WHERE um.user_id = ${userId}
      AND um.is_baseline = false
      AND m.first_seen >= now() - interval '90 days'
    GROUP BY date_trunc('day', m.first_seen at time zone 'UTC'), um.level
    ORDER BY date_trunc('day', m.first_seen at time zone 'UTC')
  `);
  const dailyJobsMap = new Map<string, Record<Level, number>>();
  for (const r of dailyNewJobsRows.rows as {
    date: string;
    level: string;
    count: number;
  }[]) {
    let entry = dailyJobsMap.get(r.date);
    if (!entry) {
      entry = { BV: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      dailyJobsMap.set(r.date, entry);
    }
    entry[r.level as Level] = r.count;
  }
  const dailyNewJobs: DailyNewJobsRow[] = Array.from(dailyJobsMap.entries()).map(
    ([date, counts]) => ({ date, counts }),
  );

  // ─── Personal-data sections (skipped entirely in demo mode) ───────
  // Dismissal patterns + API spend reveal the viewer's actual
  // job-search activity. Skip the queries in demo to save round
  // trips. (Demo user has nothing to reveal anyway.)
  let dailySpend: DailySpendRow[] = [];
  let dismissByReason: Record<string, number> = {};
  let noTagCount = 0;
  let topDismissedCompanies: { company: string; count: number }[] = [];
  let topDismissedTitles: { title: string; count: number }[] = [];
  let recentWithUrls: { m: Match; url: string }[] = [];

  if (!isDemo) {
    const dailySpendRows = await db
      .select({
        date: sql<string>`to_char(date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        total: sql<string>`coalesce(sum(${apiUsage.costUsd}), 0)::text`,
      })
      .from(apiUsage)
      .where(
        and(
          eq(apiUsage.userId, userId),
          gte(apiUsage.calledAt, sql`now() - interval '90 days'`),
        ),
      )
      .groupBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`)
      .orderBy(sql`date_trunc('day', ${apiUsage.calledAt} at time zone 'UTC')`);
    dailySpend = dailySpendRows.map((r) => ({
      date: r.date,
      spendUsd: parseFloat(r.total),
    }));

    const dismissByReasonRows = await db.execute(
      sql`SELECT unnest(um.dismiss_reason) AS reason, count(*)::int AS count
          FROM user_matches um
          WHERE um.user_id = ${userId}
            AND um.status = 'dismissed'
            AND um.dismiss_reason IS NOT NULL
          GROUP BY reason`,
    );
    for (const r of dismissByReasonRows.rows as { reason: string; count: number }[]) {
      dismissByReason[r.reason] = r.count;
    }
    const noTagRow = await db.execute(
      sql`SELECT count(*)::int AS count
          FROM user_matches um
          WHERE um.user_id = ${userId}
            AND um.status = 'dismissed'
            AND um.dismiss_reason IS NULL`,
    );
    noTagCount = (noTagRow.rows[0] as { count: number } | undefined)?.count ?? 0;

    const topDismissedCompaniesRows = await db.execute(
      sql`SELECT m.company_display_name AS company, count(*)::int AS count
          FROM user_matches um
          JOIN matches m ON m.id = um.match_id
          WHERE um.user_id = ${userId}
            AND um.status = 'dismissed'
          GROUP BY m.company_display_name
          ORDER BY count DESC
          LIMIT 5`,
    );
    topDismissedCompanies = topDismissedCompaniesRows.rows as {
      company: string;
      count: number;
    }[];

    const topDismissedTitlesRows = await db.execute(
      sql`SELECT m.title, count(*)::int AS count
          FROM user_matches um
          JOIN matches m ON m.id = um.match_id
          WHERE um.user_id = ${userId}
            AND um.status = 'dismissed'
          GROUP BY m.title
          ORDER BY count DESC
          LIMIT 10`,
    );
    topDismissedTitles = topDismissedTitlesRows.rows as {
      title: string;
      count: number;
    }[];

    const recentDismissed = await db
      .select({
        // Mirrors db/matches.ts `joinedSelect` — returns the `Match`
        // merged shape (global fields from matches.* + per-user state
        // from user_matches.*) that CompactRow expects.
        id: matches.id,
        ats: matches.ats,
        companySlug: matches.companySlug,
        companyDisplayName: matches.companyDisplayName,
        jobId: matches.jobId,
        title: matches.title,
        location: matches.location,
        firstSeen: matches.firstSeen,
        lastSeen: matches.lastSeen,
        closedAt: matches.closedAt,
        createdAt: matches.createdAt,
        level: userMatches.level,
        status: userMatches.status,
        isBaseline: userMatches.isBaseline,
        appliedAt: userMatches.appliedAt,
        dismissedAt: userMatches.dismissedAt,
        dismissReason: userMatches.dismissReason,
        fitScore: userMatches.fitScore,
        fitSummary: userMatches.fitSummary,
        fitFlag: userMatches.fitFlag,
        tier1Score: userMatches.tier1Score,
        tier1Confidence: userMatches.tier1Confidence,
        tier1IsPotentialBv: userMatches.tier1IsPotentialBv,
        tier1QuickTake: userMatches.tier1QuickTake,
        pendingBvVerification: userMatches.pendingBvVerification,
        bvReasoning: userMatches.bvReasoning,
        updatedAt: userMatches.updatedAt,
      })
      .from(userMatches)
      .innerJoin(matches, eq(matches.id, userMatches.matchId))
      .where(and(eq(userMatches.userId, userId), eq(userMatches.status, "dismissed")))
      .orderBy(desc(userMatches.updatedAt))
      .limit(25);
    recentWithUrls = await Promise.all(
      recentDismissed.map(async (m) => ({
        m,
        url: await jobUrl(m.ats, m.companySlug, m.jobId),
      })),
    );
  }

  // `or` import retained — used in older revisions; kept available
  // for any future inline filter that needs disjunction.
  void or;

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Analytics
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          Patterns &amp; signal
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-fg-muted">
          Aggregates across the current match set. Use these to spot
          companies worth re-prioritizing, dismissal patterns worth baking
          into the classifier, and roles that have quietly closed.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
          Activity (last 72h)
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <JobsByLevel data={newRolesByLevel} />
          <JobsByFit data={newRolesByFit} />
          <div className="lg:col-span-2">
            <JobsByCompany rows={newRolesByCompany} />
          </div>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
          New jobs posted
        </h2>
        <DailyNewJobsChart data={dailyNewJobs} />
      </section>

      <div className="mb-10">
        <TopCompaniesList companies={companies} />
      </div>

      {!isDemo && (
        <section className="mb-10">
          <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
            API spend
          </h2>
          <DailySpendChart data={dailySpend} />
        </section>
      )}

      <section className="mb-10">
        <ScanFailures
          latestSuccessIso={latestSuccessIso}
          targets={failingTargets}
        />
      </section>

      <section className="mb-10">
        <ClosedRoles
          latestScanIso={latestSuccessIso}
          rows={closedWithUrls}
          totalCount={closedTotal}
        />
      </section>


      {!isDemo && (
        <section className="mb-10">
          <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
            Dismissals
          </h2>
          <p className="mb-4 text-sm text-fg-muted">
            Tagged reasons when you dismiss a role from a card. Multi-select
            — one row can carry multiple tags (e.g. wrong location + wrong
            function).
          </p>
          <DismissalReasonBars counts={dismissByReason} noTag={noTagCount} />

          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Top 5 dismissed companies
              </h3>
              {topDismissedCompanies.length === 0 ? (
                <p className="text-sm text-fg-subtle">No dismissals yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {topDismissedCompanies.map((c) => (
                    <li
                      key={c.company}
                      className="flex items-baseline justify-between"
                    >
                      <span className="text-fg-muted">{c.company}</span>
                      <span className="font-mono tabular-nums text-fg-subtle">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                Top 10 dismissed titles
              </h3>
              {topDismissedTitles.length === 0 ? (
                <p className="text-sm text-fg-subtle">No dismissals yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-sm">
                  {topDismissedTitles.map((t, i) => (
                    <li
                      key={`${t.title}-${i}`}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="min-w-0 truncate text-fg-muted">
                        {t.title}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-fg-subtle">
                        {t.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {!isDemo && (
        <section>
          <h2 className="mb-4 text-sm font-semibold tracking-tight text-fg-muted">
            Recent dismissals (last 25)
          </h2>
          {recentWithUrls.length === 0 ? (
            <div className="empty-state p-6 text-center">
              <p className="text-sm text-fg-subtle">
                You haven&rsquo;t dismissed anything yet.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {recentWithUrls.map(({ m, url }) => (
                <CompactRow key={m.id} m={m} applyUrl={url} timestamp="dismissed" muted />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

// Horizontal-bar visualization for dismissal reasons. Each row's bar
// width is the count as a fraction of the largest reason count.
function DismissalReasonBars({
  counts,
  noTag,
}: {
  counts: Record<string, number>;
  noTag: number;
}) {
  const REASONS: { key: string; label: string }[] = [
    { key: "wrong_function", label: "Wrong function" },
    { key: "wrong_level", label: "Wrong level" },
    { key: "wrong_company", label: "Wrong company" },
    { key: "wrong_location", label: "Wrong location" },
    { key: "not_interested", label: "Not interested" },
  ];
  const values = REASONS.map((r) => counts[r.key] ?? 0);
  const max = Math.max(...values, noTag, 1);
  const total = values.reduce((a, b) => a + b, 0) + noTag;

  if (total === 0) {
    return (
      <div className="empty-state p-6 text-center">
        <p className="text-sm text-fg-subtle">No dismissals yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-col gap-2">
        {REASONS.map((r) => {
          const count = counts[r.key] ?? 0;
          const pct = max > 0 ? (count / max) * 100 : 0;
          return (
            <BarRow key={r.key} label={r.label} count={count} widthPct={pct} bar="bg-stone-500 dark:bg-stone-400" />
          );
        })}
        <BarRow
          label="No tag"
          count={noTag}
          widthPct={max > 0 ? (noTag / max) * 100 : 0}
          bar="bg-stone-300 dark:bg-stone-600"
          muted
        />
      </div>
    </div>
  );
}

function BarRow({
  label,
  count,
  widthPct,
  bar,
  muted,
}: {
  label: string;
  count: number;
  widthPct: number;
  bar: string;
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3">
      <span className={`text-xs ${muted ? "text-fg-subtle" : "text-fg-muted"}`}>
        {label}
      </span>
      <div className="h-3 w-full rounded-sm bg-muted">
        {count > 0 && (
          <div
            className={`h-full rounded-sm ${bar}`}
            style={{ width: `${Math.max(widthPct, 2)}%` }}
          />
        )}
      </div>
      <span className="text-right font-mono text-xs tabular-nums text-fg">
        {count}
      </span>
    </div>
  );
}
