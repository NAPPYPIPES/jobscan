import { Suspense } from "react";
import { getActiveMatches } from "@/db/matches";
import { getTargets } from "@/db/targets";
import { getViewerRole } from "@/lib/auth/viewer";
import type { Sector } from "@/lib/scan/types";
import { jobUrl } from "@/lib/scan/urls";
import MatchesView from "../_components/matches-view";

export const dynamic = "force-dynamic";

export default async function AllOpen() {
  const viewerRole = await getViewerRole();
  const [matches, targets] = await Promise.all([
    getActiveMatches({ role: viewerRole }),
    getTargets({ role: viewerRole }),
  ]);

  const sectorBySlug: Record<string, Sector> = Object.fromEntries(
    targets.map((t) => [t.slug, (t.sector ?? "tech") as Sector]),
  );

  const enriched = await Promise.all(
    matches.map(async (m) => ({
      ...m,
      applyUrl: await jobUrl(m.ats, m.companySlug, m.jobId),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-16">
      <div className="mb-6 flex flex-col gap-2 sm:mb-10">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          All open
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-5xl">
          Every open role
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-fg-muted">
          The full set of currently open matches, regardless of when they were
          first seen. Filter by level to narrow.
        </p>
      </div>

      <Suspense fallback={null}>
        <MatchesView matches={enriched} mode="all" sectorBySlug={sectorBySlug} viewerRole={viewerRole} />
      </Suspense>
    </main>
  );
}
