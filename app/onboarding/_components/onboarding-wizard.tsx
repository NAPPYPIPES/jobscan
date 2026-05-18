"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type SelectedTarget = {
  kind: "supported" | "manual";
  identifier: string; // slug for supported, manual_company_name for manual
  label: string;
};

export type OnboardingInitialState = {
  resumeMd: string;
  targets: SelectedTarget[];
  manual: SelectedTarget[];
  digestEnabled: boolean;
  digestEmail: string;
};

type SearchResult = {
  normalizedName: string;
  canonicalName: string;
  ats: string;
  slug: string | null;
  careersUrl: string | null;
  supported: boolean;
  alreadyAdded: boolean;
};

const MAX_TARGETS = 20;
const MAX_MANUAL = 10;

// ──────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────

export default function OnboardingWizard({ initial }: { initial: OnboardingInitialState }) {
  const router = useRouter();

  // Decide the starting step from prefill state. A user who pasted a
  // resume but quit before adding targets reloads onto step 2 instead
  // of being made to re-paste.
  const initialStep =
    initial.resumeMd.length === 0
      ? 1
      : initial.targets.length + initial.manual.length === 0
        ? 2
        : 2; // step 3 is always reachable by the Continue button on step 2
  const [step, setStep] = useState<1 | 2 | 3>(initialStep as 1 | 2 | 3);

  const [resumeMd, setResumeMd] = useState(initial.resumeMd);
  const [targets, setTargets] = useState<SelectedTarget[]>(initial.targets);
  const [manual, setManual] = useState<SelectedTarget[]>(initial.manual);
  const [digestEnabled, setDigestEnabled] = useState(initial.digestEnabled);
  const [digestEmail, setDigestEmail] = useState(initial.digestEmail);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
        pub-ats-radar — setup
      </p>
      <h1 className="mb-2 text-3xl font-semibold tracking-tight text-fg">
        Welcome — let&apos;s get you scanning
      </h1>
      <p className="mb-8 max-w-xl text-[14px] text-fg-subtle">
        Three quick steps: paste a resume so we can score role fit, pick the
        companies to watch, and tell us where to send your daily digest.
      </p>

      <Stepper step={step} />

      {step === 1 ? (
        <ResumeStep
          value={resumeMd}
          onChange={setResumeMd}
          onNext={() => setStep(2)}
        />
      ) : null}
      {step === 2 ? (
        <TargetsStep
          targets={targets}
          manual={manual}
          setTargets={setTargets}
          setManual={setManual}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ) : null}
      {step === 3 ? (
        <DigestStep
          digestEnabled={digestEnabled}
          digestEmail={digestEmail}
          setDigestEnabled={setDigestEnabled}
          setDigestEmail={setDigestEmail}
          onBack={() => setStep(2)}
          onComplete={() => router.push("/")}
        />
      ) : null}
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Stepper indicator
// ──────────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const labels = ["Resume", "Companies", "Digest"];
  return (
    <ol className="mb-10 flex items-center gap-2 text-[12px] text-fg-subtle">
      {labels.map((label, i) => {
        const idx = (i + 1) as 1 | 2 | 3;
        const isActive = step === idx;
        const isDone = step > idx;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-medium ${
                isActive
                  ? "border-fg bg-fg text-canvas"
                  : isDone
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-line-strong text-fg-faint"
              }`}
            >
              {isDone ? "✓" : idx}
            </span>
            <span className={isActive ? "font-medium text-fg" : ""}>{label}</span>
            {i < labels.length - 1 ? <span className="mx-2 text-fg-faint">›</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step 1 — Resume
// ──────────────────────────────────────────────────────────────────────

function ResumeStep({
  value,
  onChange,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = value.trim();
    if (trimmed.length < 200) {
      setError(
        "Resume looks short — paste at least a few paragraphs covering your background, target roles, and dealbreakers so the scorer has something to work with.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawResumeMd: trimmed }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Could not save resume. Try again.");
        setSubmitting(false);
        return;
      }
      onNext();
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-fg">Paste your resume</h2>
        <p className="text-[13px] text-fg-subtle">
          Markdown is best. Include your career narrative, target roles, and
          anything you explicitly do <em>not</em> want (industries, locations,
          dealbreakers). This text is fed into every scoring call — the more
          specific, the better the matches.
        </p>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={18}
        autoFocus
        placeholder="# Jane Doe — Senior PM

Looking for: VP of Product roles at AI-native or fintech companies, NYC or remote-friendly.

## Career
- 2019-now — Director of Product at ..."
        className="w-full rounded-lg border border-line-strong bg-input px-4 py-3 font-mono text-[13px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
      />
      {error ? <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p> : null}
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-fg-faint">
          {value.trim().length} characters
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-fg px-5 py-2.5 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? "Parsing resume (5-15s)…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step 2 — Targets
// ──────────────────────────────────────────────────────────────────────

function TargetsStep({
  targets,
  manual,
  setTargets,
  setManual,
  onBack,
  onNext,
}: {
  targets: SelectedTarget[];
  manual: SelectedTarget[];
  setTargets: (t: SelectedTarget[]) => void;
  setManual: (m: SelectedTarget[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pendingManual, setPendingManual] = useState<SearchResult | null>(null);
  const [requestQuery, setRequestQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Debounced search.
  const seqRef = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setRequestQuery(null);
      return;
    }
    const seq = ++seqRef.current;
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/onboarding/targets/search?q=${encodeURIComponent(q)}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as { results: SearchResult[] };
        if (seq !== seqRef.current) return; // stale response
        setResults(json.results);
        setRequestQuery(json.results.length === 0 ? q : null);
      } catch {
        // Network blip — keep prior results visible, no toast.
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  const targetsRemaining = MAX_TARGETS - targets.length;
  const manualRemaining = MAX_MANUAL - manual.length;
  const canContinue = targets.length + manual.length > 0;

  async function addSupported(r: SearchResult) {
    if (targets.length >= MAX_TARGETS) {
      setError(`You've hit the ${MAX_TARGETS}-target cap.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/targets/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "supported", normalizedName: r.normalizedName }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not add target.");
        return;
      }
      setTargets([
        ...targets,
        { kind: "supported", identifier: r.slug ?? r.normalizedName, label: r.canonicalName },
      ]);
      setResults((cur) =>
        cur.map((x) =>
          x.normalizedName === r.normalizedName ? { ...x, alreadyAdded: true } : x,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function addManual(r: SearchResult) {
    if (manual.length >= MAX_MANUAL) {
      setError(`You've hit the ${MAX_MANUAL} manual check-in cap.`);
      setPendingManual(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/targets/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "manual", normalizedName: r.normalizedName }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not add manual check-in.");
        return;
      }
      setManual([
        ...manual,
        { kind: "manual", identifier: r.canonicalName, label: r.canonicalName },
      ]);
      setResults((cur) =>
        cur.map((x) =>
          x.normalizedName === r.normalizedName ? { ...x, alreadyAdded: true } : x,
        ),
      );
    } finally {
      setBusy(false);
      setPendingManual(null);
    }
  }

  async function requestNew(rawQuery: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/targets/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "request", query: rawQuery }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not queue request.");
        return;
      }
      setRequestQuery(null);
      setQuery("");
    } finally {
      setBusy(false);
    }
  }

  async function removeSupported(slug: string) {
    setBusy(true);
    try {
      await fetch("/api/onboarding/targets/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "supported", identifier: slug }),
      });
      setTargets(targets.filter((t) => t.identifier !== slug));
    } finally {
      setBusy(false);
    }
  }

  async function removeManual(name: string) {
    setBusy(true);
    try {
      await fetch("/api/onboarding/targets/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "manual", identifier: name }),
      });
      setManual(manual.filter((m) => m.identifier !== name));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-fg">Pick your companies</h2>
        <p className="text-[13px] text-fg-subtle">
          Type the company name; we&apos;ll auto-scan up to{" "}
          <strong className="text-fg">{MAX_TARGETS}</strong>. Meta, Amazon, and
          Google run custom careers sites we can&apos;t scan — but you can
          track up to <strong className="text-fg">{MAX_MANUAL}</strong> of
          them as daily manual check-ins.
        </p>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a company name (e.g. Anthropic, Stripe, Google)"
        className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[14px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
      />

      {results.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line-strong bg-canvas">
          {results.map((r) => (
            <li key={r.normalizedName} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-fg">{r.canonicalName}</div>
                <div className="text-[11px] text-fg-faint">
                  {r.supported ? `Auto-scan via ${r.ats}` : "Manual check-in (custom careers site)"}
                </div>
              </div>
              {r.alreadyAdded ? (
                <span className="text-[12px] text-emerald-600 dark:text-emerald-400">Added</span>
              ) : r.supported ? (
                <button
                  type="button"
                  onClick={() => addSupported(r)}
                  disabled={busy || targetsRemaining <= 0}
                  className="rounded-md border border-fg bg-fg px-3 py-1.5 text-[12px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Add target
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPendingManual(r)}
                  disabled={busy || manualRemaining <= 0}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
                >
                  Add manual
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {requestQuery ? (
        <div className="rounded-lg border border-line-strong bg-canvas p-4">
          <p className="mb-2 text-[13px] text-fg-subtle">
            We don&apos;t have <strong className="text-fg">{requestQuery}</strong>{" "}
            in our catalog yet.
          </p>
          <button
            type="button"
            onClick={() => requestNew(requestQuery)}
            disabled={busy}
            className="rounded-md border border-line-strong px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
          >
            Add to review queue
          </button>
        </div>
      ) : null}

      {error ? <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p> : null}

      <Chips
        title={`Auto-scan targets (${targets.length}/${MAX_TARGETS})`}
        emptyText="None yet — type a name above to add."
        items={targets}
        onRemove={(t) => removeSupported(t.identifier)}
      />
      <Chips
        title={`Manual check-ins (${manual.length}/${MAX_MANUAL})`}
        emptyText="None yet — Meta/Amazon/Google etc. land here."
        items={manual}
        onRemove={(t) => removeManual(t.identifier)}
      />

      {pendingManual ? (
        <ManualConfirmDialog
          name={pendingManual.canonicalName}
          onConfirm={() => addManual(pendingManual)}
          onCancel={() => setPendingManual(null)}
        />
      ) : null}

      <div className="flex items-center justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-fg-subtle hover:text-fg"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          className="rounded-lg bg-fg px-5 py-2.5 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function Chips({
  title,
  emptyText,
  items,
  onRemove,
}: {
  title: string;
  emptyText: string;
  items: SelectedTarget[];
  onRemove: (t: SelectedTarget) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-fg-faint">{emptyText}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((t) => (
            <li
              key={`${t.kind}:${t.identifier}`}
              className="flex items-center gap-2 rounded-full border border-line-strong bg-elevated px-3 py-1 text-[12px] text-fg"
            >
              <span>{t.label}</span>
              <button
                type="button"
                aria-label={`Remove ${t.label}`}
                onClick={() => onRemove(t)}
                className="text-fg-faint hover:text-fg"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ManualConfirmDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6">
      <div className="w-full max-w-md rounded-lg border border-line-strong bg-canvas p-6 shadow-lg">
        <h3 className="mb-2 text-lg font-semibold text-fg">Custom careers site</h3>
        <p className="mb-5 text-[13px] text-fg-subtle">
          <strong className="text-fg">{name}</strong> runs a custom careers
          site we can&apos;t auto-scan. Add it to your daily manual check-in
          list instead — you&apos;ll see a reminder card on the /manual page
          each day to visit the site directly.
        </p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line-strong px-4 py-2 text-[13px] text-fg hover:bg-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-fg px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
          >
            Add to manual list
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step 3 — Digest preferences + complete
// ──────────────────────────────────────────────────────────────────────

function DigestStep({
  digestEnabled,
  digestEmail,
  setDigestEnabled,
  setDigestEmail,
  onBack,
  onComplete,
}: {
  digestEnabled: boolean;
  digestEmail: string;
  setDigestEnabled: (v: boolean) => void;
  setDigestEmail: (v: string) => void;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailValid = useMemo(
    () => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(digestEmail.trim()),
    [digestEmail],
  );

  async function onFinish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (digestEnabled && !emailValid) {
      setError("Enter a valid email to receive the digest, or turn it off.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          digestEnabled,
          digestEmail: digestEnabled ? digestEmail.trim() : null,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not finish setup.");
        setSubmitting(false);
        return;
      }
      onComplete();
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onFinish} className="flex flex-col gap-6">
      <div>
        <h2 className="mb-1 text-xl font-semibold text-fg">Daily digest</h2>
        <p className="text-[13px] text-fg-subtle">
          Each morning we&apos;ll email you the new BV / HIGH / strong-fit
          MEDIUM roles your scan turned up overnight. Skip the digest if you
          prefer to read everything in the dashboard.
        </p>
      </div>

      <label className="flex items-center gap-3 text-[14px] text-fg">
        <input
          type="checkbox"
          checked={digestEnabled}
          onChange={(e) => setDigestEnabled(e.target.checked)}
          className="h-4 w-4"
        />
        Send me the daily digest
      </label>

      <div className="flex flex-col gap-2">
        <label htmlFor="digest-email" className="text-[12px] uppercase tracking-[0.12em] text-fg-subtle">
          Digest email
        </label>
        <input
          id="digest-email"
          type="email"
          value={digestEmail}
          onChange={(e) => setDigestEmail(e.target.value)}
          disabled={!digestEnabled}
          className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[14px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none disabled:opacity-50"
        />
        <p className="text-[12px] text-fg-faint">
          Defaults to your account email; change it if you want digests to land
          somewhere else.
        </p>
      </div>

      {error ? <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p> : null}

      <div className="flex items-center justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-fg-subtle hover:text-fg"
        >
          ← Back
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-fg px-5 py-2.5 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? "Finishing…" : "Finish setup"}
        </button>
      </div>
    </form>
  );
}
