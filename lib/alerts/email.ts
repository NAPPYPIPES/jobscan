import { Resend } from "resend";
import type { FitFlag } from "@/lib/fit/score";
import type { Level, Sector } from "@/lib/scan/types";

// Subject prefix is unique enough to build a Gmail label/filter on.
// "par" = pub-ats-radar.
const SUBJECT_PREFIX = "par job tracker";

export type AlertRow = {
  level: Level;
  title: string;
  companyDisplayName: string;
  location: string;
  url: string;
  firstSeen: Date;
  sector: Sector;
  fitScore: number | null;
  fitSummary: string | null;
  fitFlag: FitFlag | null;
};

// Two slices:
//   today     — rows first-seen in the last 24h (primary section)
//   yesterday — rows first-seen 24-48h ago (context tail)
// Either can be empty; the email still sends so you get a reliable
// daily ping regardless of activity.
export type DigestData = {
  today: AlertRow[];
  yesterday: AlertRow[];
};

function uniqueCompanies(rows: AlertRow[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const r of rows) {
    if (seen.has(r.companyDisplayName)) continue;
    seen.add(r.companyDisplayName);
    list.push(r.companyDisplayName);
  }
  return list;
}

// 3 or fewer: list them all. 4+: list 2 then "+ N more" so the subject
// stays readable on a phone lock screen (~50 chars).
function companyText(companies: string[]): string {
  if (companies.length <= 3) return companies.join(", ");
  return `${companies.slice(0, 2).join(", ")} + ${companies.length - 2} more`;
}

function qualifier(rows: AlertRow[]): string {
  const tiers: string[] = [];
  if (rows.some((r) => r.level === "BV")) tiers.push("BV");
  if (rows.some((r) => r.level === "HIGH")) tiers.push("HIGH");
  if (rows.some((r) => r.level === "MEDIUM")) tiers.push("MED");
  return tiers.join("/");
}

function buildSubject(data: DigestData): string {
  const { today, yesterday } = data;
  if (today.length > 0) {
    const q = qualifier(today);
    const c = companyText(uniqueCompanies(today));
    const noun = today.length === 1 ? "role" : "roles";
    return `${SUBJECT_PREFIX} · ${today.length} new ${q} ${noun} at ${c}`;
  }
  if (yesterday.length > 0) {
    return `${SUBJECT_PREFIX} · 0 today, ${yesterday.length} from yesterday`;
  }
  return `${SUBJECT_PREFIX} · No new BV/HIGH in the last 48h`;
}

// YYYY-MM-DD in Eastern time. Used to decide whether a discovery
// timestamp falls on the digest's "today" calendar day or "yesterday".
// Edit the timeZone string to match wherever you read the digest from.
const DIGEST_TZ = "America/New_York";

function dateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DIGEST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function hourString(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    hour: "numeric",
    hour12: true,
  })
    .format(d)
    .toLowerCase()
    .replace(/\s/g, "");
}

function formatDiscoveredAt(d: Date, now: Date): string {
  const dStr = dateString(d);
  const nowStr = dateString(now);
  if (dStr === nowStr) return hourString(d);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dStr === dateString(yesterday)) return `yesterday ${hourString(d)}`;
  return `2 days ago ${hourString(d)}`;
}

// Render one section's rows (BV → HIGH → MEDIUM; section header from
// the caller).
function renderSectionRows(rows: AlertRow[], now: Date): string[] {
  const lines: string[] = [];
  for (const level of ["BV", "HIGH", "MEDIUM"] as const) {
    const slice = rows.filter((r) => r.level === level);
    if (slice.length === 0) continue;
    lines.push(level === "MEDIUM" ? "MED" : level);
    for (const r of slice) {
      const when = formatDiscoveredAt(r.firstSeen, now);
      // Unscored rows still surface in the digest with a [pending]
      // marker — scoring is decoupled from scan and may not have
      // caught up by the send time. Better to show the row than hide
      // it on a missed score.
      const fit = r.fitScore != null ? ` [${r.fitScore.toFixed(1)}]` : " [pending]";
      lines.push(
        `- ${when}${fit} — ${r.title} at ${r.companyDisplayName} — ${r.location} · ${r.sector}`,
      );
      lines.push(`  ${r.url}`);
      if (r.fitSummary) {
        lines.push(`  → ${r.fitSummary}`);
      }
    }
    lines.push("");
  }
  return lines;
}

function buildText(data: DigestData, now: Date, siteUrl: string): string {
  const { today, yesterday } = data;
  const lines: string[] = [];

  const total = today.length + yesterday.length;
  if (total === 0) {
    lines.push("No new BV/HIGH roles in the last 48h.");
  } else {
    lines.push(
      `${total} new BV/HIGH role${total === 1 ? "" : "s"} in the last 48h ` +
        `(${today.length} today, ${yesterday.length} yesterday).`,
    );
  }
  lines.push("");

  // Today section — primary signal.
  lines.push(`== TODAY (last 24h) ==`);
  lines.push("");
  if (today.length === 0) {
    lines.push("No new BV/HIGH roles in the last 24h.");
    lines.push("");
  } else {
    lines.push(...renderSectionRows(today, now));
  }

  // Yesterday section — only render if it has content; skip noise.
  if (yesterday.length > 0) {
    lines.push(`== YESTERDAY (24-48h ago) ==`);
    lines.push("");
    lines.push(...renderSectionRows(yesterday, now));
  }

  lines.push("—");
  lines.push(`All open roles: ${siteUrl}`);
  return lines.join("\n");
}

// Send the daily digest. Always sends if RESEND_API_KEY is configured,
// even when both today + yesterday are empty — a reliable daily ping
// is the whole point. Returns false on missing API key or Resend error.
export async function sendDigest(data: DigestData): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[alerts] RESEND_API_KEY not set — skipping email send");
    return false;
  }
  const from = process.env.ALERT_FROM_EMAIL;
  const to = process.env.ALERT_TO_EMAIL;
  if (!from || !to) {
    console.warn("[alerts] ALERT_FROM_EMAIL or ALERT_TO_EMAIL not set — skipping email send");
    return false;
  }
  const siteUrl = process.env.SITE_URL ?? "(set SITE_URL in env)";

  const total = data.today.length + data.yesterday.length;

  const resend = new Resend(apiKey);
  const { data: result, error } = await resend.emails.send({
    from,
    to,
    subject: buildSubject(data),
    text: buildText(data, new Date(), siteUrl),
  });
  if (error) {
    console.error("[alerts] Resend send failed:", error);
    return false;
  }
  console.log(
    `[alerts] digest sent (today=${data.today.length}, yesterday=${data.yesterday.length}, ` +
      `total=${total}), id=${result?.id}`,
  );
  return true;
}
