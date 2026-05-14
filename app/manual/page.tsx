import { getManualCompanies } from "@/db/manual-companies";
import { getViewerRole } from "@/lib/auth/viewer";
import ManualChecklist from "./manual-checklist";

// Server-side wrapper. Reads the manual checklist from DB and hands
// it to the client component that owns the interactivity (optimistic
// checks, status polling). Async because db/manual-companies reads
// from Postgres.
export const dynamic = "force-dynamic";

export default async function ManualPage() {
  const [companies, viewerRole] = await Promise.all([
    getManualCompanies(),
    getViewerRole(),
  ]);
  return (
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      <div className="mb-8 flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          Daily checklist
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          Manual checks
        </h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-fg-muted">
          Companies with custom ATSs &mdash; visit each careers page daily to
          catch new roles. Click the button to open and mark checked in one go.
        </p>
        <ManualChecklist companies={companies} viewerRole={viewerRole} />
      </div>
    </main>
  );
}
