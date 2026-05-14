import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import Nav from "./_components/nav";
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-fg antialiased">
        <Nav />
        {children}
      </body>
    </html>
  );
}
