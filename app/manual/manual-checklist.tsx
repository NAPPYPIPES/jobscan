"use client";

import { useEffect, useState } from "react";
import type { ManualCompany, ManualSector } from "@/db/manual-companies";
import type { Role } from "@/lib/auth/viewer";
import {
  BORDER_CLASSES,
  getStaleness,
  lastCheckedLabel,
  needsAttention,
  type Staleness,
} from "./staleness";

// Client half of /manual. The server page (page.tsx) reads the
// MANUAL_COMPANIES list (which uses node:fs via the config loader) and
// passes it down as a prop so this client component stays free of
// server-only imports.

type LastChecked = Record<string, string>;

const DEMO_TOOLTIP = "Demo mode — opens the careers page but doesn't record a check.";

export default function ManualChecklist({
  companies,
  viewerRole,
}: {
  companies: ManualCompany[];
  viewerRole: Role;
}) {
  const isDemo = viewerRole === "demo";
  const [lastChecked, setLastChecked] = useState<LastChecked>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // In demo mode there's no per-viewer check history — skip the
    // status fetch entirely. The cards still render (showing
    // "Never checked" in the staleness ring), which honestly makes
    // the demo experience cleaner: no real-user check timestamps
    // leaking into the demo view.
    if (isDemo) {
      setLoaded(true);
      return;
    }
    fetch("/api/manual/status")
      .then((r) => r.json())
      .then((d: { lastChecked: LastChecked }) => setLastChecked(d.lastChecked ?? {}))
      .catch(() => setLastChecked({}))
      .finally(() => setLoaded(true));
  }, [isDemo]);

  // Optimistic update: stamp now() locally so the card flips state
  // before the POST returns. The POST is fire-and-forget — failure
  // is silent (next page load will reconcile from DB).
  // Demo viewers skip the POST entirely; the link still opens, but
  // we don't write to the manual_checks ledger (which would also
  // fail server-side via requireOwner, but skipping client-side
  // avoids a misleading "now checked" optimistic flip).
  function handleCheck(name: string) {
    if (isDemo) return;
    const nowIso = new Date().toISOString();
    setLastChecked((prev) => ({ ...prev, [name]: nowIso }));
    fetch("/api/manual/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: name }),
    }).catch(() => {
      /* swallow — UI already updated, will reconcile on next load */
    });
  }

  const stalenessByName: Record<string, Staleness> = {};
  for (const c of companies) {
    // While loading, show neutral "today" border so we don't briefly
    // flash all-cards-orange before the status fetch completes.
    stalenessByName[c.name] = loaded ? getStaleness(lastChecked[c.name]) : "today";
  }
  const checkedTodayCount = companies.filter(
    (c) => stalenessByName[c.name] === "today",
  ).length;
  const needsAttentionCount = companies.filter((c) =>
    needsAttention(stalenessByName[c.name]),
  ).length;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span>
          <span className="font-mono font-semibold tabular-nums text-fg">
            {loaded ? checkedTodayCount : "—"}
          </span>{" "}
          checked in last 24h
        </span>
        <span className="text-fg-faint">&middot;</span>
        <span>
          <span className="font-mono font-semibold tabular-nums text-fg">
            {loaded ? needsAttentionCount : "—"}
          </span>{" "}
          need attention
        </span>
        <span className="text-fg-faint">&middot;</span>
        <span className="text-fg-subtle">Resets daily</span>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {companies.map((c) => (
          <CompanyCard
            key={c.name}
            company={c}
            lastChecked={lastChecked[c.name]}
            staleness={stalenessByName[c.name]}
            onCheck={() => handleCheck(c.name)}
            isDemo={isDemo}
          />
        ))}
      </div>
    </>
  );
}

function CompanyCard({
  company,
  lastChecked,
  staleness,
  onCheck,
  isDemo,
}: {
  company: ManualCompany;
  lastChecked: string | undefined;
  staleness: Staleness;
  onCheck: () => void;
  isDemo: boolean;
}) {
  const isChecked = staleness === "today";
  const linkTitle = isDemo ? DEMO_TOOLTIP : undefined;
  const ctaLabel = isDemo
    ? "Open careers page →"
    : isChecked
      ? "Checked today — revisit"
      : "Check now →";
  return (
    <div
      className={`flex h-full flex-col rounded-xl bg-surface p-5 transition-colors ${BORDER_CLASSES[staleness]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`text-lg font-semibold tracking-tight ${
            isChecked ? "text-fg-subtle" : "text-fg"
          }`}
        >
          {isChecked && <span className="mr-1 text-emerald-600 dark:text-emerald-400">✓</span>}
          {company.name}
        </h3>
        <SectorPill sector={company.sector} />
      </div>
      <p className="mt-1 font-mono text-[11px] tabular-nums text-fg-subtle">{lastCheckedLabel(lastChecked)}</p>
      <p
        className={`mt-3 flex-1 text-sm ${
          isChecked ? "text-fg-subtle" : "text-fg-muted"
        }`}
      >
        {company.description}
      </p>
      <a
        href={company.careersUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onCheck}
        title={linkTitle}
        className={`mt-4 block w-full rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors ${
          isChecked
            ? "bg-muted text-fg-muted hover:bg-line"
            : "bg-fg text-canvas hover:opacity-90"
        }`}
      >
        {ctaLabel}
      </a>
    </div>
  );
}

// Sector pills now use the existing accent palette instead of
// introducing sky / violet that appear nowhere else. Tech is the
// neutral default; finserv keeps amber (already an accent in the
// system); consulting picks indigo; other stays muted stone.
const SECTOR_PILL_CLASSES: Record<ManualSector, string> = {
  tech: "bg-muted text-fg-muted ring-line",
  finserv: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/20",
  consulting: "bg-indigo-50 text-indigo-700 ring-indigo-200/70 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-400/20",
  other: "bg-muted text-fg-subtle ring-line",
};

function SectorPill({ sector }: { sector: ManualSector }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${SECTOR_PILL_CLASSES[sector]}`}
    >
      {sector}
    </span>
  );
}
