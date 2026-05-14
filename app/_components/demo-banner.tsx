"use client";

import { useEffect, useState } from "react";

// Single-line strip pinned above the nav. Renders only when the
// server has resolved the viewer as 'demo' — it's mounted
// unconditionally from layout.tsx but the parent passes a `show`
// prop so SSR matches client output (avoids hydration mismatch).
//
// Dismissable per session via sessionStorage (NOT localStorage) — the
// banner returns on every new tab/window so the demo framing stays
// clear for new visitors but doesn't nag a returning viewer who
// already acknowledged it during this session.

const DISMISS_KEY = "par-demo-banner-dismissed";

export default function DemoBanner({ show }: { show: boolean }) {
  // Track dismissal across mount; default to "not dismissed" so SSR
  // and first client render agree. The useEffect below quickly
  // hydrates the actual sessionStorage state after mount.
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    setHydrated(true);
  }, []);

  if (!show) return null;
  if (hydrated && dismissed) return null;

  return (
    <div className="sticky top-0 z-30 flex items-center justify-center gap-3 border-b border-amber-300/80 bg-amber-100 px-4 py-1.5 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/60 dark:text-amber-200">
      <span className="inline-flex items-center gap-2">
        <span className="rounded bg-amber-900/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-300/15 dark:text-amber-200">
          Demo
        </span>
        <span>
          Real job postings · illustrative scoring against an example
          resume ·{" "}
          <a
            href="https://github.com/lukedevmurphy/pub-ats-radar"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline decoration-amber-700/40 underline-offset-2 hover:decoration-amber-900 dark:decoration-amber-400/40 dark:hover:decoration-amber-200"
          >
            fork to make it yours →
          </a>
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
        aria-label="Dismiss demo banner"
        className="ml-2 rounded p-0.5 text-amber-700 transition-colors hover:bg-amber-900/10 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-200/10 dark:hover:text-amber-100"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
          <path d="M3 3 L9 9 M9 3 L3 9" />
        </svg>
      </button>
    </div>
  );
}
