import { and, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { matches } from "@/db/schema";
import { jobUrl } from "@/lib/scan/urls";
import type { Level } from "@/lib/scan/types";
import TopCompaniesList, {
  type CompanyData,
} from "../_components/top-companies-list";
import CompactRow from "../_components/compact-row";

export const dynamic = "force-dynamic";

export default async function Analytics() {
  const db = getDb();

  // Top companies by open roles (excluding dismissed + baseline). The
  // client component owns the sort + level-filter UI; here we just
  // assemble the raw per-(slug, level) counts.
  const perSlugLevel = await db
    .select({
      slug: matches.companySlug,
      name: matches.companyDisplayName,
      level: matches.level,
      count: sql<number>`count(*)::int`,
    })
    .from(matches)
    .where(
      and(ne(matches.status, "dismissed"), eq(matches.isBaseline, false)),
    )
    .groupBy(matches.companySlug, matches.companyDisplayName, matches.level);

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

  // Dismissal reason breakdown. Each matches row's dismiss_reason is
  // a text[] (multi-select); unnest expands it so a row tagged with
  // both wrong_level + wrong_location counts under both.
  const dismissByReasonRows = await db.execute(
    sql`SELECT unnest(dismiss_reason) AS reason, count(*)::int AS count
        FROM matches
        WHERE status = 'dismissed' AND dismiss_reason IS NOT NULL
        GROUP BY reason`,
  );
  const dismissByReason: Record<string, number> = {};
  for (const r of dismissByReasonRows.rows as { reason: string; count: number }[]) {
    dismissByReason[r.reason] = r.count;
  }
  const noTagRow = await db.execute(
    sql`SELECT count(*)::int AS count
        FROM matches
        WHERE status = 'dismissed' AND dismiss_reason IS NULL`,
  );
  const noTagCount =
    (noTagRow.rows[0] as { count: number } | undefined)?.count ?? 0;

  // Top 5 dismissed companies + top 10 dismissed titles.
  const topDismissedCompaniesRows = await db.execute(
    sql`SELECT company_display_name AS company, count(*)::int AS count
        FROM matches
        WHERE status = 'dismissed'
        GROUP BY company_display_name
        ORDER BY count DESC
        LIMIT 5`,
  );
  const topDismissedCompanies = topDismissedCompaniesRows.rows as {
    company: string;
    count: number;
  }[];

  const topDismissedTitlesRows = await db.execute(
    sql`SELECT title, count(*)::int AS count
        FROM matches
        WHERE status = 'dismissed'
        GROUP BY title
        ORDER BY count DESC
        LIMIT 10`,
  );
  const topDismissedTitles = topDismissedTitlesRows.rows as {
    title: string;
    count: number;
  }[];

  // Most-recent 25 dismissals for the inline list. Pre-compute apply
  // URLs server-side because jobUrl is now async and CompactRow is
  // server-rendered.
  const recentDismissed = await db
    .select()
    .from(matches)
    .where(eq(matches.status, "dismissed"))
    .orderBy(desc(matches.updatedAt))
    .limit(25);
  const recentWithUrls = await Promise.all(
    recentDismissed.map(async (m) => ({
      m,
      url: await jobUrl(m.ats, m.companySlug, m.jobId),
    })),
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-stone-400">
          Analytics
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
          Patterns &amp; signal
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-stone-500">
          Aggregates across the current match set. Use these to spot
          companies worth re-prioritizing and dismissal patterns worth
          baking into the classifier.
        </p>
      </div>

      <div className="mb-10">
        <TopCompaniesList companies={companies} />
      </div>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-stone-700">
          Dismissals
        </h2>
        <p className="mb-4 text-sm text-stone-600">
          Tagged reasons when you dismiss a role from a card. Multi-select
          — one row can carry multiple tags (e.g. wrong location + wrong
          function).
        </p>
        <DismissalReasonBars counts={dismissByReason} noTag={noTagCount} />

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Top 5 dismissed companies
            </h3>
            {topDismissedCompanies.length === 0 ? (
              <p className="text-sm text-stone-400">No dismissals yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {topDismissedCompanies.map((c) => (
                  <li
                    key={c.company}
                    className="flex items-baseline justify-between"
                  >
                    <span className="text-stone-700">{c.company}</span>
                    <span className="tabular-nums text-stone-500">{c.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-stone-500">
              Top 10 dismissed titles
            </h3>
            {topDismissedTitles.length === 0 ? (
              <p className="text-sm text-stone-400">No dismissals yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {topDismissedTitles.map((t, i) => (
                  <li
                    key={`${t.title}-${i}`}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-stone-700">
                      {t.title}
                    </span>
                    <span className="shrink-0 tabular-nums text-stone-500">
                      {t.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-stone-700">
          Recent dismissals (last 25)
        </h2>
        {recentWithUrls.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white/40 p-6 text-center">
            <p className="text-sm text-stone-500">
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
      <div className="rounded-lg border border-dashed border-stone-300 bg-white/40 p-6 text-center">
        <p className="text-sm text-stone-500">No dismissals yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex flex-col gap-2">
        {REASONS.map((r) => {
          const count = counts[r.key] ?? 0;
          const pct = max > 0 ? (count / max) * 100 : 0;
          return (
            <BarRow key={r.key} label={r.label} count={count} widthPct={pct} bar="bg-stone-500" />
          );
        })}
        <BarRow
          label="No tag"
          count={noTag}
          widthPct={max > 0 ? (noTag / max) * 100 : 0}
          bar="bg-stone-300"
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
      <span className={`text-xs ${muted ? "text-stone-400" : "text-stone-600"}`}>
        {label}
      </span>
      <div className="h-3 w-full rounded-sm bg-stone-100">
        {count > 0 && (
          <div
            className={`h-full rounded-sm ${bar}`}
            style={{ width: `${Math.max(widthPct, 2)}%` }}
          />
        )}
      </div>
      <span className="text-right text-xs tabular-nums text-stone-700">
        {count}
      </span>
    </div>
  );
}
