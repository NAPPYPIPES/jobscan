import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Nav from "./_components/nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "pub-ats-radar",
  description: "Personal job scanner — ATS APIs, fit scoring, daily digest.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-[#ece6d8] font-sans text-stone-900 antialiased">
        <Nav />
        {children}
      </body>
    </html>
  );
}
