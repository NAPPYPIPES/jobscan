"use client";

import Image from "next/image";
import { useState } from "react";
import { logoUrl } from "@/lib/scan/logos";

// Letter-circle fallback used when no domain is mapped or the logo
// fetch 404s.
function FallbackLogo({ displayName }: { displayName: string }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-fg-muted">
      {displayName.charAt(0)}
    </div>
  );
}

function CompanyLogo({
  domain,
  displayName,
}: {
  domain?: string;
  displayName: string;
}) {
  const [errored, setErrored] = useState(false);
  if (!domain || errored) return <FallbackLogo displayName={displayName} />;
  return (
    <Image
      src={logoUrl(domain)}
      alt={`${displayName} logo`}
      width={32}
      height={32}
      className="h-8 w-8 shrink-0 rounded-lg object-contain"
      onError={() => setErrored(true)}
      unoptimized
    />
  );
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 text-fg-subtle transition-transform duration-150 ${
        collapsed ? "" : "rotate-90"
      }`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

type Props = {
  displayName: string;
  domain?: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
};

export default function CompanyHeader({
  displayName,
  domain,
  count,
  collapsed,
  onToggle,
}: Props) {
  const noun = count === 1 ? "role" : "roles";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="-mx-2 mb-3 flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-muted sm:py-1.5"
    >
      <CompanyLogo domain={domain} displayName={displayName} />
      <h2 className="truncate text-base font-semibold tracking-tight text-fg">
        {displayName}
      </h2>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-line">
        <span className="font-mono tabular-nums text-fg-muted">{count}</span>
        <span className="text-fg-subtle">{noun}</span>
      </span>
      <Chevron collapsed={collapsed} />
    </button>
  );
}
