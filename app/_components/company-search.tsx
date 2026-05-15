"use client";

// Fast company-search input with typeahead dropdown. The matches set
// is small (~100 distinct companies), so all filtering is in-memory
// substring matching — no debouncing or async lookups needed.
//
// Two behaviors coexist:
//   1. Free-text substring filter — same as the prior search input.
//      Updates the `q` URL param via onChangeQuery; matches view
//      narrows results by company name AND keeps the text in the box.
//   2. Pick-from-dropdown — when the user clicks a suggestion, we
//      switch to the strict slug filter via onSelectCompany(slug),
//      clear the text query, and close the dropdown. The selected
//      company appears as a chip below.
//
// Keyboard: ArrowUp/Down to navigate suggestions, Enter to select,
// Escape to close. Click-outside also closes.

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { logoUrl } from "@/lib/scan/logos";

// Debounce window for syncing the local input value up to the parent
// (and through it, the URL + heavy match-list re-filter). Typing feels
// instant — the input + dropdown re-render against local state — and
// the expensive cascade fires once per pause. 150ms is below human
// perception of lag while still coalescing rapid typing.
const QUERY_DEBOUNCE_MS = 150;

export type CompanyOption = {
  slug: string;
  displayName: string;
  // Matches count in the current view (post level/sector/since filters
  // but pre-search). Drives the trailing count badge per row so the
  // user knows which suggestions actually have roles.
  count: number;
  domain?: string;
};

type Props = {
  companies: CompanyOption[];
  query: string;
  onChangeQuery: (q: string) => void;
  // Called when the user selects a company from the dropdown — usually
  // sets the strict company= URL param and clears q. Caller decides
  // the URL semantics.
  onSelectCompany: (slug: string) => void;
  // Currently-pinned company (display name) and a clear handler.
  // Renders as a removable chip below the input when set.
  pinnedCompanyName: string | null;
  onClearPinned: () => void;
};

// Substring match, case-insensitive, on display name OR slug. Slug
// match catches "ramp" → "Ramp" without the user thinking about case.
function matchScore(query: string, c: CompanyOption): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const name = c.displayName.toLowerCase();
  const slug = c.slug.toLowerCase();
  // Prefix match on name ranks highest. Then slug prefix. Then any
  // substring. Returning a number lets us sort: lower = better.
  if (name.startsWith(q)) return 0;
  if (slug.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (slug.includes(q)) return 3;
  return null;
}

// Small fallback that mirrors CompanyHeader's letter-circle. Kept inline
// so the dropdown row layout stays compact.
function RowLogo({ domain, displayName }: { domain?: string; displayName: string }) {
  const [errored, setErrored] = useState(false);
  if (!domain || errored) {
    return (
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-semibold text-fg-muted">
        {displayName.charAt(0)}
      </div>
    );
  }
  return (
    <Image
      src={logoUrl(domain)}
      alt=""
      width={24}
      height={24}
      className="h-6 w-6 shrink-0 rounded object-contain"
      onError={() => setErrored(true)}
      unoptimized
    />
  );
}

export default function CompanySearch({
  companies,
  query,
  onChangeQuery,
  onSelectCompany,
  pinnedCompanyName,
  onClearPinned,
}: Props) {
  // Local input state — re-renders only this component on each
  // keystroke (cheap). The URL + match-list filter is sync'd via the
  // debounced effect below so the heavy cascade doesn't fire 6+ times
  // a second while typing.
  const [localQuery, setLocalQuery] = useState(query);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // External query changes (URL nav, parent state reset) win over the
  // local optimistic value. Sync only when they differ to avoid a
  // setState loop with the debounced upward-sync effect below.
  useEffect(() => {
    setLocalQuery((prev) => (prev === query ? prev : query));
  }, [query]);

  // Debounced upward sync. Local edits propagate to the parent (and
  // thus the URL) once the user pauses typing. Selection / clear
  // bypass this via flushQuery() which fires immediately.
  useEffect(() => {
    if (localQuery === query) return;
    const t = setTimeout(() => {
      onChangeQuery(localQuery);
    }, QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [localQuery, query, onChangeQuery]);

  // Force-flush the debounce — used when committing a selection or
  // clearing the input. Sends the value up immediately so subsequent
  // navigation doesn't lag a frame behind the visible state.
  const flushQuery = (next: string) => {
    setLocalQuery(next);
    onChangeQuery(next);
  };

  // Filtered + sorted suggestions. Capped at 8 — anything more swamps
  // the dropdown on mobile and there's no realistic case where the
  // user wants to scroll a list of 80 companies in a typeahead.
  // Memoized against LOCAL query so the dropdown updates per
  // keystroke, not per debounce tick.
  const suggestions = useMemo(() => {
    const q = localQuery.trim();
    if (!q) {
      // Empty query: show all companies with at least one role,
      // sorted by count desc (most-active first). Lets the dropdown
      // double as a "browse companies" view when the input is focused
      // but empty.
      return companies
        .filter((c) => c.count > 0)
        .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName))
        .slice(0, 8);
    }
    const scored: Array<{ c: CompanyOption; score: number }> = [];
    for (const c of companies) {
      const s = matchScore(q, c);
      if (s !== null) scored.push({ c, score: s });
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      // Within the same match tier, rank by count then alpha.
      if (a.c.count !== b.c.count) return b.c.count - a.c.count;
      return a.c.displayName.localeCompare(b.c.displayName);
    });
    return scored.slice(0, 8).map((s) => s.c);
  }, [query, companies]);

  // Reset focus when suggestions change so the highlighted row is
  // always the top of the new list (avoids "I navigated to row 5 then
  // typed and now nothing's highlighted").
  useEffect(() => {
    setFocusIdx(0);
  }, [suggestions]);

  // Click-outside: close dropdown.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const pick = suggestions[focusIdx];
      if (pick) {
        e.preventDefault();
        onSelectCompany(pick.slug);
        flushQuery("");
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={localQuery}
        onChange={(e) => {
          setLocalQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search company"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // Use 16px font on mobile to prevent iOS zoom-on-focus.
        // sm: drops back to the existing 14px tight look.
        className="w-full rounded-lg border border-line bg-input px-3.5 py-2.5 pr-9 text-base text-fg placeholder:text-fg-faint focus:border-line-strong focus:outline-none sm:py-2 sm:text-sm"
        aria-label="Search company"
        aria-expanded={open}
        aria-controls="company-search-listbox"
        aria-autocomplete="list"
        role="combobox"
      />
      {localQuery && (
        <button
          type="button"
          onClick={() => {
            flushQuery("");
            setOpen(false);
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-muted hover:text-fg"
        >
          ×
        </button>
      )}

      {open && suggestions.length > 0 && (
        <ul
          ref={listRef}
          id="company-search-listbox"
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-line bg-surface shadow-lg"
        >
          {suggestions.map((s, i) => {
            const isFocused = i === focusIdx;
            return (
              <li
                key={s.slug}
                role="option"
                aria-selected={isFocused}
                onMouseEnter={() => setFocusIdx(i)}
                onMouseDown={(e) => {
                  // mousedown not click — fires before the input's
                  // blur event, so the dropdown doesn't disappear
                  // mid-tap on mobile.
                  e.preventDefault();
                  onSelectCompany(s.slug);
                  flushQuery("");
                  setOpen(false);
                }}
                className={`flex cursor-pointer items-center gap-3 px-3 py-3 text-sm transition-colors ${
                  isFocused ? "bg-muted" : ""
                } sm:py-2`}
              >
                <RowLogo domain={s.domain} displayName={s.displayName} />
                <span className="flex-1 truncate text-fg">{s.displayName}</span>
                <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                  {s.count}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {pinnedCompanyName && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
            Filter
          </span>
          <button
            type="button"
            onClick={onClearPinned}
            className="inline-flex items-center gap-1.5 rounded-full bg-fg px-3 py-1.5 text-xs font-medium tracking-tight text-canvas transition-opacity hover:opacity-80 sm:py-1"
            title="Clear company filter"
          >
            <span>{pinnedCompanyName}</span>
            <span aria-hidden className="text-canvas/70">×</span>
          </button>
        </div>
      )}
    </div>
  );
}
