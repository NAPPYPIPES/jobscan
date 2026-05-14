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
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-[10px] font-semibold tracking-tight text-canvas">
            par
          </span>
          <span className="text-sm font-semibold tracking-tight text-fg">
            pub-ats-radar
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1 rounded-full border border-line bg-pill p-1 shadow-pill">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-medium tracking-tight transition-colors ${
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
