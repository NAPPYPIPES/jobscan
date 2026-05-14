// Five-state staleness model for the /manual daily checklist. The
// thresholds (24h / 48h / 72h) and color mapping live here so the
// card border, the human-readable label, and the "needs attention"
// header counter all stay aligned.
//
// State is computed at render time from `Date.now()` minus the ISO
// timestamp returned by /api/manual/status. The page does not
// re-render on a timer — staleness ticks over only on page load /
// refresh, which is fine for a daily-cadence personal tool.

export type Staleness = "today" | "1-2d" | "2-3d" | "3plus" | "never";

export function getStaleness(lastChecked: string | undefined): Staleness {
  if (!lastChecked) return "never";
  const hoursAgo = (Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 24) return "today";
  if (hoursAgo < 48) return "1-2d";
  if (hoursAgo < 72) return "2-3d";
  return "3plus";
}

export function lastCheckedLabel(lastChecked: string | undefined): string {
  if (!lastChecked) return "Never checked";
  const hoursAgo = Math.floor(
    (Date.now() - new Date(lastChecked).getTime()) / (1000 * 60 * 60),
  );
  if (hoursAgo < 1) return "Checked just now";
  if (hoursAgo < 24) return `Checked ${hoursAgo}h ago`;
  const daysAgo = Math.floor(hoursAgo / 24);
  return `Checked ${daysAgo} day${daysAgo !== 1 ? "s" : ""} ago`;
}

// "Needs attention" — the subset that drives the header's second
// counter. Amber, orange, and never. ("today" and "1-2d" are healthy.)
export function needsAttention(s: Staleness): boolean {
  return s === "2-3d" || s === "3plus" || s === "never";
}

// Card border classes per state. border-2 (not ring) so the "never"
// state can use border-dashed — Tailwind's ring utility is box-shadow
// based and doesn't support dashed.
export const BORDER_CLASSES: Record<Staleness, string> = {
  today: "border-2 border-emerald-400",
  "1-2d": "border-2 border-lime-400",
  "2-3d": "border-2 border-amber-400",
  "3plus": "border-2 border-orange-500",
  never: "border-2 border-dashed border-stone-300",
};
