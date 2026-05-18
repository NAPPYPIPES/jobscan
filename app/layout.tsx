import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Nav from "./_components/nav";
import DemoBanner from "./_components/demo-banner";
import { getViewerRole } from "@/lib/auth/viewer";
import { getUserExtras, ensureUserExtras } from "@/db/user-extras";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "pub-ats-radar",
  description: "Personal job scanner — ATS APIs, fit scoring, daily digest.",
};

// Theme init has to land before first paint, otherwise dark-preference
// users see a flash of the wrong theme. Inlined into <head> as a sync
// script; reads the persisted choice from localStorage and falls back
// to LIGHT (not system) — light is the canonical brand experience and
// users opt into dark or system tracking explicitly via the toggle.
// Keep this in lockstep with _components/theme-toggle.tsx — both must
// agree on the storage key, the {system|light|dark} state machine,
// and the "light" default when nothing is saved.
const themeInitScript = `
(function() {
  try {
    var saved = localStorage.getItem('par-theme');
    var theme = saved || 'light';
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = theme === 'dark' || (theme === 'system' && prefersDark);
    if (isDark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

// Routes the onboarding redirect should NOT fire on, even if the user
// hasn't completed onboarding yet. /onboarding itself (obvious) plus
// the NextAuth catch-all (used for sign-out callbacks etc.) and the
// register endpoint (handled separately from this layout chain
// anyway, but listed for clarity).
const ONBOARDING_BYPASS_PREFIXES = ["/onboarding", "/api/auth", "/login", "/signup"];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const h = await headers();
  const userId = h.get("x-par-user-id");
  const pathname = h.get("x-par-pathname") ?? "";

  // Onboarding gate. Skip for the routes above and for unauthenticated
  // contexts (middleware redirects unauth to /login before we get
  // here; the userId check is defensive). The bypass list keeps us
  // out of redirect loops while the wizard itself is open.
  if (
    userId &&
    !ONBOARDING_BYPASS_PREFIXES.some((p) => pathname.startsWith(p))
  ) {
    let extras = await getUserExtras(userId);
    // A NextAuth Google sign-in that hit a brand-new email never gets
    // a user_extras row — only /api/auth/register inserts that. Make
    // the wizard's first impression "fill in your details" instead
    // of an opaque error.
    if (!extras) {
      await ensureUserExtras(userId);
      extras = await getUserExtras(userId);
    }
    if (extras && !extras.onboardingCompletedAt) {
      redirect("/onboarding");
    }
  }

  // Read role on the server so the banner-or-not decision is baked
  // into SSR output. Phase 1 collapsed demo to a single role, so the
  // banner is dead — kept until Phase 7 cleanup deletes it entirely.
  const role = await getViewerRole();
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-fg antialiased">
        <DemoBanner show={role === "demo"} />
        <Nav />
        {children}
      </body>
    </html>
  );
}
