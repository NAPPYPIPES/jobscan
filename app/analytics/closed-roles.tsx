import type { Match } from "@/db/schema";
import type { Level } from "@/lib/scan/types";

const LEVEL_PILL: Record<Level, string> = {
  BV: "bg-indigo-50 text-indigo-700 ring-indigo-200/70",
  HIGH: "bg-rose-50 text-rose-700 ring-rose-200/70",
  MEDIUM: "bg-amber-50 text-amber-800 ring-amber-200/70",
  LOW: "bg-stone-100 text-stone-600 ring-stone-200",
};
const LEVEL_LABEL: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};

function shortAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo" : `${months}mo`;
}

// Authoritative closed-roles list. closed_at is set by the scanner
// after a successful scan that didn't return a previously-known
// job_id for that slug — see persistScanResults in db/matches.ts. A
// fetch failure leaves closed_at untouched, so the surfaced rows are
// genuine ATS removals, not collateral damage from a flaky API call.
export type ClosedRow = {
  m: Match;
  applyUrl: string;
};

export default function ClosedRoles({
  latestScanIso,
  rows,
  totalCount,
}: {
  latestScanIso: string | null;
  rows: ClosedRow[];
  totalCount: number;
}) {
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-stone-700">
          Closed at the ATS
        </h2>
        <p className="text-[11px] text-stone-400">
          Latest successful scan:{" "}
          <span className="font-mono tabular-nums text-stone-500">
            {latestScanIso ? formatScanTime(latestScanIso) : "—"}
          </span>
        </p>
      </div>
      <p className="mb-4 text-sm text-stone-600">
        Roles the scanner confirmed are gone from the ATS — already excluded
        from /all and the digest. Listed here as an audit trail; nothing for
        you to act on.
      </p>

      {totalCount === 0 ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-white/40 p-6 text-center">
          <p className="text-sm text-stone-500">
            Nothing closed yet — every active match was confirmed by a recent scan.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="border-b border-stone-100 px-4 py-2.5 text-[11px] text-stone-500">
            <span className="font-semibold tabular-nums text-stone-800">
              {totalCount}
            </span>{" "}
            closed · showing {rows.length} most recent
          </div>
          <ul>
            {rows.map(({ m, applyUrl }, i) => (
              <li
                key={m.id}
                className={`flex items-center gap-3 px-4 py-2 ${
                  i > 0 ? "border-t border-stone-100" : ""
                }`}
              >
                <span
                  className={`inline-flex w-12 shrink-0 justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${LEVEL_PILL[m.level]}`}
                >
                  {LEVEL_LABEL[m.level]}
                </span>
                <span className="hidden w-32 shrink-0 truncate text-xs text-stone-500 sm:inline">
                  {m.companyDisplayName}
                </span>
                <a
                  href={applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-stone-700 line-through decoration-stone-400 hover:text-stone-900 hover:decoration-stone-600"
                  title="Open the old ATS link — expect a 404 / removed page"
                >
                  {m.title}
                </a>
                <span
                  className="w-20 shrink-0 text-right text-xs tabular-nums text-stone-400"
                  title={
                    m.closedAt
                      ? `Closed at: ${new Date(m.closedAt).toISOString()}`
                      : undefined
                  }
                >
                  {m.closedAt ? `${shortAgo(new Date(m.closedAt))} ago` : "—"}
                </span>
              </li>
            ))}
          </ul>
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
