"use client";

// Settings UI for the two-tier scoring funnel's cost-control caps.
// Reads caps from server-side props (DB-backed via db/scoring-caps),
// edits in client-side draft state, saves via server action defined
// in actions.ts.
//
// Demo viewers see all values but the save button is hidden — server
// action also rejects demo viewers as belt-and-suspenders.

import { useState, useTransition } from "react";
import type { ScoringCaps } from "@/lib/config/scoring-caps-types";
import { updateScoringCapsAction } from "./actions";

type SpendRow = { spent: number; cap: number };

export function ScoringCapsEditor({
  initial,
  spend,
  readOnly,
}: {
  initial: ScoringCaps;
  spend: {
    triage: SpendRow;
    score: SpendRow;
    summary: SpendRow;
    total: SpendRow;
  };
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState<ScoringCaps>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateScoringCapsAction(draft);
      if (result.ok) setSaved(true);
      else setError(result.error);
    });
  };

  // Convenience setters — each one returns a partial mutator that's
  // bound to the nested object via spread. Keeps the field components
  // declarative (`value={...} onChange={...}` with no extra plumbing).
  const setPerDay = (patch: Partial<ScoringCaps["perDayCaps"]>) =>
    setDraft({ ...draft, perDayCaps: { ...draft.perDayCaps, ...patch } });
  const setMonthly = (patch: Partial<ScoringCaps["monthlyCapsUsd"]>) =>
    setDraft({ ...draft, monthlyCapsUsd: { ...draft.monthlyCapsUsd, ...patch } });
  const setThresholds = (patch: Partial<ScoringCaps["haikuToSonnetThresholds"]>) =>
    setDraft({
      ...draft,
      haikuToSonnetThresholds: { ...draft.haikuToSonnetThresholds, ...patch },
    });

  return (
    <div className="space-y-8">
      {readOnly && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/80 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="inline-flex shrink-0 items-center rounded bg-amber-900/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-300/15 dark:text-amber-200">
            Demo
          </span>
          <span>
            Read-only view. Values are the owner&rsquo;s current
            production caps. Controls are disabled — fork the repo and
            run your own deployment to edit.
          </span>
        </div>
      )}

      {/* Spend bars — month-to-date vs cap, color-coded */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SpendBar label="Triage (Haiku)" {...spend.triage} />
        <SpendBar label="Score (Sonnet)" {...spend.score} />
        <SpendBar label="Summary (Haiku)" {...spend.summary} />
        <SpendBar label="Total" {...spend.total} emphasized />
      </div>

      {/* Per-day volume caps */}
      <FieldGroup title="Per-day volume caps">
        <NumberField
          label="Max new jobs per day (global)"
          help="Across all companies. Truncates net-new arrivals when reached. Existing-row updates still pass."
          value={draft.perDayCaps.maxNewJobsPerDay}
          onChange={(v) => setPerDay({ maxNewJobsPerDay: v })}
          min={1}
          max={500}
          readOnly={readOnly}
        />
        <NumberField
          label="Max new jobs per company per day"
          help="Stops one chatty Greenhouse from eating the entire daily quota."
          value={draft.perDayCaps.maxNewJobsPerCompanyPerDay}
          onChange={(v) => setPerDay({ maxNewJobsPerCompanyPerDay: v })}
          min={1}
          max={100}
          readOnly={readOnly}
        />
      </FieldGroup>

      {/* Monthly spend caps */}
      <FieldGroup title="Monthly spend caps (USD)">
        <CurrencyField
          label="Triage budget (Haiku, per-role triage)"
          value={draft.monthlyCapsUsd.triage}
          onChange={(v) => setMonthly({ triage: v })}
          step={0.5}
          min={0}
          max={50}
          readOnly={readOnly}
        />
        <CurrencyField
          label="Score budget (Sonnet, deep-scoring)"
          value={draft.monthlyCapsUsd.score}
          onChange={(v) => setMonthly({ score: v })}
          step={1}
          min={0}
          max={150}
          readOnly={readOnly}
        />
        <CurrencyField
          label="Summary budget (Haiku, pro/con summaries)"
          value={draft.monthlyCapsUsd.summary}
          onChange={(v) => setMonthly({ summary: v })}
          step={0.5}
          min={0}
          max={50}
          readOnly={readOnly}
        />
        <CurrencyField
          label="Total monthly cap (master kill-switch)"
          help="When reached, all Claude calls stop until next month. Hard ceiling."
          value={draft.monthlyCapsUsd.total}
          onChange={(v) => setMonthly({ total: v })}
          step={1}
          min={1}
          max={200}
          readOnly={readOnly}
          emphasized
        />
      </FieldGroup>

      {/* Escalation thresholds */}
      <FieldGroup title="Tier-1 → Tier-2 escalation thresholds">
        <NumberField
          label="Score floor (any confidence)"
          help="Haiku scores ≥ this always escalate to Sonnet, regardless of confidence."
          value={draft.haikuToSonnetThresholds.scoreFloorAlways}
          onChange={(v) => setThresholds({ scoreFloorAlways: v })}
          min={0}
          max={10}
          step={0.1}
          readOnly={readOnly}
        />
        <NumberField
          label="High-confidence floor"
          help="Minimum Haiku score to escalate when confidence = high."
          value={draft.haikuToSonnetThresholds.highConfidenceFloor}
          onChange={(v) => setThresholds({ highConfidenceFloor: v })}
          min={0}
          max={10}
          step={0.1}
          readOnly={readOnly}
        />
        <NumberField
          label="Medium-confidence floor"
          help="Minimum Haiku score to escalate when confidence = medium."
          value={draft.haikuToSonnetThresholds.mediumConfidenceFloor}
          onChange={(v) => setThresholds({ mediumConfidenceFloor: v })}
          min={0}
          max={10}
          step={0.1}
          readOnly={readOnly}
        />
        <ToggleField
          label="Force-escalate on potential BV flag"
          help="When Haiku flags is_potential_bv = true, escalate to Sonnet for verification regardless of score."
          value={draft.haikuToSonnetThresholds.forceEscalateOnPotentialBv}
          onChange={(v) => setThresholds({ forceEscalateOnPotentialBv: v })}
          readOnly={readOnly}
        />
      </FieldGroup>

      {!readOnly && (
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={save}
            disabled={!dirty || pending}
            className="rounded-md bg-fg px-4 py-2 text-sm font-medium text-bg shadow-card transition-colors hover:bg-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
          {saved && (
            <span className="text-sm text-emerald-700 dark:text-emerald-400">
              Saved. Next scan tick uses new values.
            </span>
          )}
          {error && (
            <span className="text-sm text-rose-700 dark:text-rose-400">
              {error}
            </span>
          )}
          {dirty && !saved && !error && (
            <span className="text-sm text-fg-subtle">Unsaved changes</span>
          )}
        </div>
      )}
    </div>
  );
}

function SpendBar({
  label,
  spent,
  cap,
  emphasized = false,
}: {
  label: string;
  spent: number;
  cap: number;
  emphasized?: boolean;
}) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const color =
    pct >= 95
      ? "bg-rose-500"
      : pct >= 80
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div
      className={`rounded-lg border bg-surface p-3 shadow-card ${emphasized ? "border-line-strong" : "border-line"}`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm tabular-nums text-fg">
        ${spent.toFixed(2)} / ${cap.toFixed(2)}
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
        {title}
      </h3>
      <div className="space-y-3 rounded-lg border border-line bg-surface p-4 shadow-card">
        {children}
      </div>
    </div>
  );
}

function NumberField({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step,
  readOnly,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <label className="block text-sm text-fg">{label}</label>
        {help && <p className="mt-0.5 text-xs text-fg-subtle">{help}</p>}
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        min={min}
        max={max}
        step={step ?? 1}
        readOnly={readOnly}
        disabled={readOnly}
        className="w-24 rounded border border-line bg-surface px-2 py-1 text-right font-mono text-sm tabular-nums text-fg focus:border-line-strong focus:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50"
      />
    </div>
  );
}

function CurrencyField(props: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  readOnly: boolean;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-4 ${props.emphasized ? "border-t border-line pt-3 first:border-t-0 first:pt-0" : ""}`}
    >
      <div className="flex-1">
        <label
          className={`block text-sm ${props.emphasized ? "font-medium text-fg" : "text-fg"}`}
        >
          {props.label}
        </label>
        {props.help && (
          <p className="mt-0.5 text-xs text-fg-subtle">{props.help}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-sm text-fg-subtle">$</span>
        <input
          type="number"
          value={props.value}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) props.onChange(v);
          }}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          readOnly={props.readOnly}
          disabled={props.readOnly}
          className="w-20 rounded border border-line bg-surface px-2 py-1 text-right font-mono text-sm tabular-nums text-fg focus:border-line-strong focus:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function ToggleField({
  label,
  help,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <label className="block text-sm text-fg">{label}</label>
        {help && <p className="mt-0.5 text-xs text-fg-subtle">{help}</p>}
      </div>
      <button
        type="button"
        onClick={() => !readOnly && onChange(!value)}
        disabled={readOnly}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 ${value ? "bg-fg" : "bg-line"}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-bg shadow ring-0 transition-transform ${value ? "translate-x-5" : "translate-x-0"}`}
        />
      </button>
    </div>
  );
}
