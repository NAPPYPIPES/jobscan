// Shared route-loading skeleton. Rendered instantly by Next.js via
// each route's loading.tsx while the force-dynamic server component
// runs its DB queries — without this, navigation shows a frozen page
// until the render completes. Pure presentational; widths mirror the
// real page headers so the swap-in doesn't jump.

export default function PageSkeleton({
  width = "4xl",
}: {
  width?: "4xl" | "5xl";
}) {
  const maxW = width === "4xl" ? "max-w-4xl px-4 py-8 sm:px-6 sm:py-16" : "max-w-5xl px-6 py-12 sm:py-16";
  return (
    <main className={`mx-auto ${maxW}`} aria-busy="true">
      <div className="mb-10 flex animate-pulse flex-col gap-3">
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="h-10 w-72 rounded bg-muted" />
        <div className="h-4 w-full max-w-xl rounded bg-muted" />
      </div>
      <div className="flex animate-pulse flex-col gap-4">
        <div className="h-24 rounded-lg border border-line bg-muted" />
        <div className="h-24 rounded-lg border border-line bg-muted" />
        <div className="h-24 rounded-lg border border-line bg-muted" />
        <div className="h-24 rounded-lg border border-line bg-muted" />
      </div>
    </main>
  );
}
