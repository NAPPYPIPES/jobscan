"use client";

import { useEffect, useState } from "react";
import type { ManualCompany, ManualSector } from "@/db/manual-companies";
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

export default function ManualChecklist({ companies }: { companies: ManualCompany[] }) {
  const [lastChecked, setLastChecked] = useState<LastChecked>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/manual/status")
      .then((r) => r.json())
      .then((d: { lastChecked: LastChecked }) => setLastChecked(d.lastChecked ?? {}))
      .catch(() => setLastChecked({}))
      .finally(() => setLoaded(true));
  }, []);

  // Optimistic update: stamp now() locally so the card flips state
  // before the POST returns. The POST is fire-and-forget — failure
  // is silent (next page load will reconcile from DB).
  function handleCheck(name: string) {
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
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600">
        <span>
          <span className="font-semibold text-stone-900">
            {loaded ? checkedTodayCount : "—"}
          </span>{" "}
          checked in last 24h
        </span>
        <span className="text-stone-300">&middot;</span>
        <span>
          <span className="font-semibold text-stone-900">
            {loaded ? needsAttentionCount : "—"}
          </span>{" "}
          need attention
        </span>
        <span className="text-stone-300">&middot;</span>
        <span className="text-stone-400">Resets daily</span>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {companies.map((c) => (
          <CompanyCard
            key={c.name}
            company={c}
            lastChecked={lastChecked[c.name]}
            staleness={stalenessByName[c.name]}
            onCheck={() => handleCheck(c.name)}
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
}: {
  company: ManualCompany;
  lastChecked: string | undefined;
  staleness: Staleness;
  onCheck: () => void;
}) {
  const isChecked = staleness === "today";
  return (
    <div
      className={`flex h-full flex-col rounded-xl bg-white p-5 transition-colors ${BORDER_CLASSES[staleness]}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`text-lg font-semibold tracking-tight ${
            isChecked ? "text-stone-400" : "text-stone-900"
          }`}
        >
          {isChecked && <span className="mr-1 text-emerald-600">✓</span>}
          {company.name}
        </h3>
        <SectorPill sector={company.sector} />
      </div>
      <p className="mt-1 text-xs text-stone-400">{lastCheckedLabel(lastChecked)}</p>
      <p
        className={`mt-3 flex-1 text-sm ${
          isChecked ? "text-stone-400" : "text-stone-500"
        }`}
      >
        {company.description}
      </p>
      <a
        href={company.careersUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onCheck}
        className={`mt-4 block w-full rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors ${
          isChecked
            ? "bg-stone-100 text-stone-500 hover:bg-stone-200"
            : "bg-stone-900 text-white hover:bg-stone-800"
        }`}
      >
        {isChecked ? "Checked today — revisit" : "Check now →"}
      </a>
    </div>
  );
}

const SECTOR_PILL_CLASSES: Record<ManualSector, string> = {
  tech: "bg-sky-50 text-sky-700 ring-sky-200/70",
  finserv: "bg-emerald-50 text-emerald-700 ring-emerald-200/70",
  consulting: "bg-violet-50 text-violet-700 ring-violet-200/70",
  other: "bg-stone-100 text-stone-700 ring-stone-200/70",
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
