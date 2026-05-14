import type { Ats } from "@/lib/scan/types";

const ATS_LABEL: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workday: "Workday",
};

export type FailingTarget = {
  slug: string;
  displayName: string;
  ats: Ats;
  // ISO timestamp of the last successful per-target scan; null if the
  // target has never scanned successfully (brand-new addition).
  lastSuccessIso: string | null;
};

function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return `${mins}m ago`;
  }
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}

// Surfaces which targets the scanner couldn't reach in the latest cycle.
// The scanner only marks roles closed for slugs whose fetch succeeded;
// rows for failed slugs stay visible in /all (correct — we don't know
// whether they're closed or just unreachable). This panel makes that
// state legible: "we're not closing X's stale matches because we
// couldn't talk to X's ATS."
export default function ScanFailures({
  latestSuccessIso,
  targets,
}: {
  latestSuccessIso: string | null;
  targets: FailingTarget[];
}) {
  // Split into "never scanned" (brand new) vs "failing now" (was working,
  // currently isn't). The two cases warrant different mental models.
  const neverScanned = targets.filter((t) => !t.lastSuccessIso);
  const failing = targets.filter((t) => t.lastSuccessIso);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-fg-muted">
          Scan failures
        </h2>
        <p className="text-[11px] text-fg-subtle">
          Latest successful scan:{" "}
          <span className="font-mono tabular-nums text-fg-muted">
            {latestSuccessIso ? formatScanTime(latestSuccessIso) : "—"}
          </span>
        </p>
      </div>

      {targets.length === 0 ? (
        <div className="empty-state p-6 text-center">
          <p className="text-sm text-fg-subtle">
            All targets scanned successfully in the most recent cycle.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-surface shadow-card">
          <div className="border-b border-line-subtle px-4 py-2.5 text-[11px] text-fg-subtle">
            <span className="font-mono font-semibold tabular-nums text-fg">
              {targets.length}
            </span>{" "}
            of all targets · their stale matches stay open until the scan
            recovers.
          </div>

          {failing.length > 0 && (
            <ul>
              {failing.map((t, i) => (
                <li
                  key={t.slug}
                  className={`flex items-center gap-3 px-4 py-2 text-sm ${
                    i > 0 ? "border-t border-line-subtle" : ""
                  }`}
                >
                  <span className="inline-flex w-20 shrink-0 justify-center rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-700 ring-1 ring-inset ring-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/20">
                    Failing
                  </span>
                  <span className="w-20 shrink-0 text-xs text-fg-subtle">
                    {ATS_LABEL[t.ats]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {t.displayName}
                  </span>
                  <span
                    className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-muted"
                    title={t.lastSuccessIso ?? undefined}
                  >
                    {t.lastSuccessIso ? shortAgo(t.lastSuccessIso) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {neverScanned.length > 0 && (
            <ul
              className={
                failing.length > 0 ? "border-t-2 border-line" : ""
              }
            >
              {neverScanned.map((t, i) => (
                <li
                  key={t.slug}
                  className={`flex items-center gap-3 px-4 py-2 text-sm ${
                    i > 0 ? "border-t border-line-subtle" : ""
                  }`}
                >
                  <span className="inline-flex w-20 shrink-0 justify-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted ring-1 ring-inset ring-line">
                    New
                  </span>
                  <span className="w-20 shrink-0 text-xs text-fg-subtle">
                    {ATS_LABEL[t.ats]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {t.displayName}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-subtle">
                    never
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function formatScanTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}
