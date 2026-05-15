"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./theme-toggle";

const LINKS = [
  { href: "/", label: "Recent" },
  { href: "/all", label: "All open" },
  { href: "/manual", label: "Manual" },
  { href: "/analytics", label: "Analytics" },
  { href: "/docs", label: "Docs" },
];

export default function Nav() {
  const pathname = usePathname();
  // Hide on the login page — pre-auth visitors shouldn't see the
  // route list (and clicking any link from /login just bounces them
  // right back).
  if (pathname === "/login") return null;
  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-3 sm:gap-3 sm:px-6 sm:py-4">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-[10px] font-semibold tracking-tight text-canvas">
            par
          </span>
          {/* Brand wordmark hidden on small screens — the icon carries
              identity; the saved horizontal space is critical for the
              5-link nav to fit on a phone without overflow. */}
          <span className="hidden text-sm font-semibold tracking-tight text-fg sm:inline">
            pub-ats-radar
          </span>
        </Link>
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Horizontal scroll on overflow — keeps every link reachable
              on the narrowest phones without forcing a hamburger menu
              (5 links are still scannable and the active route is
              auto-scrolled into view by the browser when needed). */}
          <nav className="-mx-1 flex items-center gap-1 overflow-x-auto rounded-full border border-line bg-pill p-1 shadow-pill [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:overflow-visible">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium tracking-tight transition-colors sm:px-3.5 ${
                    active
                      ? "bg-fg text-canvas"
                      : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
