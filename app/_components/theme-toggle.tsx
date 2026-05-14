"use client";

import { useEffect, useState } from "react";

// Three-state toggle: system | light | dark. Persists to localStorage
// under key "par-theme". The init script in app/layout.tsx applies the
// initial state synchronously before paint; this component re-applies
// on user changes and listens for OS preference flips while in
// "system" mode.
//
// Contract: state machine + storage key MUST match the inline script
// in layout.tsx. Don't rename "par-theme" without updating both.

type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "par-theme";

function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
}

export default function ThemeToggle() {
  // SSR-safe initial state: assume "system" on the server. After
  // mount we read the actual saved preference and re-render — the
  // toggle UI may flicker once on first hydration, but the underlying
  // theme class is already correct (set by the inline init script).
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
    setTheme(saved);
    setMounted(true);
  }, []);

  // While in "system" mode, follow OS-level changes live. Removing the
  // listener when leaving system mode keeps an explicit user choice
  // sticky — the OS flipping doesn't override it.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const choose = (next: Theme) => {
    setTheme(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  // Pre-mount placeholder keeps layout stable but renders nothing
  // visually — avoids hydration mismatch on the icon.
  if (!mounted) {
    return <div className="h-7 w-[88px]" aria-hidden />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-line bg-pill p-0.5"
    >
      <ThemeButton
        active={theme === "system"}
        onClick={() => choose("system")}
        label="System theme"
      >
        <SystemIcon />
      </ThemeButton>
      <ThemeButton
        active={theme === "light"}
        onClick={() => choose("light")}
        label="Light theme"
      >
        <SunIcon />
      </ThemeButton>
      <ThemeButton
        active={theme === "dark"}
        onClick={() => choose("dark")}
        label="Dark theme"
      >
        <MoonIcon />
      </ThemeButton>
    </div>
  );
}

function ThemeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-full transition-colors ${
        active
          ? "bg-fg text-canvas"
          : "text-fg-subtle hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5 v1.5 M8 13 v1.5 M1.5 8 h1.5 M13 8 h1.5 M3.5 3.5 l1.06 1.06 M11.44 11.44 l1.06 1.06 M3.5 12.5 l1.06-1.06 M11.44 4.56 l1.06-1.06" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M13.4 9.8a5.5 5.5 0 0 1-7.2-7.2 5.5 5.5 0 1 0 7.2 7.2z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
      <path strokeLinecap="round" d="M5.5 14h5" />
    </svg>
  );
}
