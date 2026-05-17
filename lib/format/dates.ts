// Shared date formatters for the dashboard surface. Centralized here so
// any new page/view uses the same format conventions instead of
// re-rolling Intl.DateTimeFormat inline.

const SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const LONG = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return SHORT.format(new Date(d));
}

export function longDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return LONG.format(new Date(d));
}
