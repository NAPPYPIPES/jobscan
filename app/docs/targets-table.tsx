"use client";

import { useMemo, useState } from "react";
import type { Sector } from "@/lib/scan/types";

// Server pre-fetches all target rows + per-slug stats (count,
// lastSeen) and passes a serialized form here. The client owns the
// sort UI: click a header to switch the sort column (resets to
// ascending); click the same header again to flip direction.

export type TargetRow = {
  slug: string;
  ats: string;
  displayName: string;
  sector: Sector;
  count: number;
  // lastSeen is serialized as ISO string across the server→client
  // boundary; we parse to Date here for comparisons + formatting.
  lastSeenIso: string | null;
};

const ATS_LABEL: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workday: "Workday",
};

type SortKey =
  | "displayName"
  | "ats"
  | "slug"
  | "sector"
  | "count"
  | "lastSeen"
  | "status";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "displayName", label: "Company", align: "left" },
  { key: "ats", label: "ATS", align: "left" },
  { key: "slug", label: "Slug", align: "left" },
  { key: "sector", label: "Sector", align: "left" },
  { key: "count", label: "Open roles", align: "right" },
  { key: "lastSeen", label: "Last scan", align: "left" },
  { key: "status", label: "Status", align: "left" },
];

function shortDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// Returns a -1/0/1 comparator given two rows + the sort key.
function compareRows(a: TargetRow, b: TargetRow, key: SortKey): number {
  if (key === "count") return a.count - b.count;
  if (key === "lastSeen") {
    const ax = a.lastSeenIso ? new Date(a.lastSeenIso).getTime() : -Infinity;
    const bx = b.lastSeenIso ? new Date(b.lastSeenIso).getTime() : -Infinity;
    return ax - bx;
  }
  if (key === "status") {
    // Active (>0 roles) sorts above inactive (0 roles); ties broken
    // by displayName so the table stays deterministic when most
    // rows have 0 in-scope.
    const ax = a.count > 0 ? 1 : 0;
    const bx = b.count > 0 ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" });
  }
  // Remaining keys are string-valued: displayName, ats, slug, sector
  return a[key].localeCompare(b[key], "en", { sensitivity: "base" });
}

export default function TargetsTable({ rows }: { rows: TargetRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("displayName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareRows(a, b, sortKey);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <table className="w-full text-sm">
        <thead className="bg-muted text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          <tr>
            {COLUMNS.map((c) => {
              const active = c.key === sortKey;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  <button
                    type="button"
                    onClick={() => onHeaderClick(c.key)}
                    className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${
                      active
                        ? "text-fg"
                        : "text-fg-subtle hover:text-fg"
                    }`}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}
                    <span
                      aria-hidden
                      className={`text-[8px] ${active ? "opacity-100" : "opacity-30"}`}
                    >
                      {active && sortDir === "desc" ? "▼" : "▲"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => {
            const last = t.lastSeenIso ? new Date(t.lastSeenIso) : null;
            const status = t.count > 0 ? "Active" : "No roles found";
            return (
              <tr
                key={t.slug}
                className="border-t border-line-subtle transition-colors hover:bg-muted"
              >
                <td className="px-3 py-2 font-medium text-fg">
                  {t.displayName}
                </td>
                <td className="px-3 py-2 text-fg-muted">{ATS_LABEL[t.ats] ?? t.ats}</td>
                <td className="px-3 py-2 font-mono text-xs text-fg-subtle">
                  {t.slug}
                </td>
                <td className="px-3 py-2 text-fg-muted">{t.sector}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                  {t.count}
                </td>
                <td className="px-3 py-2 font-mono text-xs tabular-nums text-fg-subtle">{shortDate(last)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      t.count > 0
                        ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/20"
                        : "bg-muted text-fg-subtle ring-1 ring-inset ring-line"
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
  );
}
