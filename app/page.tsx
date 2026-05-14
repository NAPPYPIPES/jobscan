import { Suspense } from "react";
import { getActiveMatches } from "@/db/matches";
import { getTargets } from "@/db/targets";
import { getViewerRole } from "@/lib/auth/viewer";
import type { Sector } from "@/lib/scan/types";
import { jobUrl } from "@/lib/scan/urls";
import MatchesView from "./_components/matches-view";

// Server-side render per request — DB state changes whenever the cron
// scan runs, so static generation would serve stale data.
export const dynamic = "force-dynamic";

export default async function Home() {
  const viewerRole = await getViewerRole();
  const [matches, targets] = await Promise.all([
    getActiveMatches({ excludeApplied: true, excludeBaseline: true, role: viewerRole }),
    getTargets({ role: viewerRole }),
  ]);

  // Slug → sector dict, built server-side and passed to the client.
  // Avoids the client having to import @/lib/scan/targets — which is
  // now server-only since `getTargets()` touches the DB.
  const sectorBySlug: Record<string, Sector> = Object.fromEntries(
    targets.map((t) => [t.slug, (t.sector ?? "tech") as Sector]),
  );

  // Pre-compute the apply URL for each row so the client component
  // doesn't need to import @/lib/scan/urls (which is async and touches
  // db/workday-tenants under the hood).
  const enriched = await Promise.all(
    matches.map(async (m) => ({
      ...m,
      applyUrl: await jobUrl(m.ats, m.companySlug, m.jobId),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <div className="mb-10 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Recent
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          New matches
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-fg-muted">
          Roles first seen in the selected window across{" "}
          <span className="font-medium text-fg">target companies</span>.
          Click any card to open the apply page.
        </p>
      </div>

      <Suspense fallback={null}>
        <MatchesView matches={enriched} mode="recent" sectorBySlug={sectorBySlug} viewerRole={viewerRole} />
      </Suspense>
    </main>
  );
}
