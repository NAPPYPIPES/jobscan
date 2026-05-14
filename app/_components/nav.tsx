"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
    <header className="sticky top-0 z-20 border-b border-stone-300/60 bg-[#ece6d8]/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-stone-900 text-[10px] font-semibold tracking-tight text-white">
            par
          </span>
          <span className="text-sm font-semibold tracking-tight text-stone-900">
            pub-ats-radar
          </span>
        </Link>
        <nav className="flex items-center gap-1 rounded-full border border-stone-200 bg-white/70 p-1 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium tracking-tight transition-colors ${
                  active
                    ? "bg-stone-900 text-white"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
