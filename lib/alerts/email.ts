import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userExtras } from "@/db/schema";
import { checkSpend } from "@/lib/fit/spendCaps";
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

// HTML escape — only the four characters that can break attribute /
// text contexts in an email body. Resend renders our HTML verbatim,
// so anything user-derived (title, company, location, summary) has
// to pass through this before being interpolated.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Color palette mirrors the site (app/globals.css + match-card.tsx
// LEVEL_PILL / fitBadgeClass). Inline styles only — most email
// clients (Gmail, Outlook) strip <style> blocks or class attributes.
const COLORS = {
  canvas: "#ece6d8",
  surface: "#ffffff",
  muted: "#f5f1e6",
  line: "#e7e5e4",
  lineStrong: "#d6d3d1",
  fg: "#1c1917",
  fgMuted: "#57534e",
  fgSubtle: "#78716c",
  fgFaint: "#a8a29e",
} as const;

const LEVEL_STYLE: Record<Level, { bg: string; fg: string; ring: string }> = {
  BV:     { bg: "#eef2ff", fg: "#4338ca", ring: "#c7d2fe" },
  HIGH:   { bg: "#fff1f2", fg: "#be123c", ring: "#fecdd3" },
  MEDIUM: { bg: "#fffbeb", fg: "#92400e", ring: "#fde68a" },
  LOW:    { bg: "#f5f5f4", fg: "#78716c", ring: "#e7e5e4" },
};

const LEVEL_LABEL_HTML: Record<Level, string> = {
  BV: "BV",
  HIGH: "HIGH",
  MEDIUM: "MED",
  LOW: "LOW",
};

function fitBadgeStyle(score: number): { bg: string; fg: string; ring: string } {
  if (score >= 8.0) return { bg: "#ecfdf5", fg: "#047857", ring: "#a7f3d0" };
  if (score >= 6.0) return { bg: "#fffbeb", fg: "#b45309", ring: "#fde68a" };
  return { bg: "#f5f5f4", fg: "#78716c", ring: "#e7e5e4" };
}

function pill(label: string, bg: string, fg: string, ring: string): string {
  return (
    `<span style="display:inline-block;padding:2px 8px;border-radius:4px;` +
    `background:${bg};color:${fg};border:1px solid ${ring};` +
    `font-size:10px;font-weight:700;letter-spacing:0.06em;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">` +
    `${esc(label)}</span>`
  );
}

function renderRowHtml(r: AlertRow, now: Date): string {
  const when = esc(formatDiscoveredAt(r.firstSeen, now));
  const lvl = LEVEL_STYLE[r.level];
  const levelPill = pill(LEVEL_LABEL_HTML[r.level], lvl.bg, lvl.fg, lvl.ring);
  let fitPill = "";
  if (r.fitScore != null) {
    const f = fitBadgeStyle(r.fitScore);
    fitPill = pill(r.fitScore.toFixed(1), f.bg, f.fg, f.ring);
  } else {
    fitPill = pill("pending", COLORS.muted, COLORS.fgSubtle, COLORS.line);
  }

  const title = esc(r.title);
  const company = esc(r.companyDisplayName);
  const location = esc(r.location);
  const sector = esc(r.sector);
  const url = esc(r.url);
  const summary = r.fitSummary ? esc(r.fitSummary) : null;

  return (
    `<tr><td style="padding:0 0 14px 0;">` +
    // Card
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="background:${COLORS.surface};border:1px solid ${COLORS.line};` +
    `border-radius:8px;border-collapse:separate;">` +

    // Row 1: pills + timestamp
    `<tr><td style="padding:12px 16px 6px 16px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">` +
    `<tr>` +
    `<td style="vertical-align:middle;">${levelPill}&nbsp;${fitPill}</td>` +
    `<td align="right" style="vertical-align:middle;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;` +
    `font-size:11px;color:${COLORS.fgSubtle};white-space:nowrap;">${when}</td>` +
    `</tr></table>` +
    `</td></tr>` +

    // Row 2: title (bold) "at" company (bold underlined link)
    `<tr><td style="padding:0 16px 4px 16px;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:15px;line-height:1.4;color:${COLORS.fg};">` +
    `<a href="${url}" target="_blank" rel="noopener" ` +
    `style="color:${COLORS.fg};text-decoration:none;">` +
    `<strong style="font-weight:700;">${title}</strong>` +
    `<span style="color:${COLORS.fgSubtle};font-weight:400;"> at </span>` +
    `<strong style="font-weight:700;text-decoration:underline;text-decoration-color:${COLORS.lineStrong};` +
    `text-underline-offset:2px;">${company}</strong>` +
    `</a>` +
    `</td></tr>` +

    // Row 3: location · sector
    `<tr><td style="padding:0 16px 12px 16px;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:12px;color:${COLORS.fgMuted};">` +
    `${location} <span style="color:${COLORS.fgFaint};">·</span> ${sector}` +
    `</td></tr>` +

    // Row 4 (optional): one-line fit summary, left-bordered like the
    // site's "Why you fit" callout
    (summary
      ? `<tr><td style="padding:0 16px 14px 16px;">` +
        `<div style="border-left:2px solid ${COLORS.lineStrong};padding:2px 0 2px 10px;` +
        `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
        `font-size:13px;line-height:1.5;color:${COLORS.fgMuted};">` +
        `${summary}</div></td></tr>`
      : "") +

    `</table>` +
    `</td></tr>`
  );
}

function renderSectionHtml(title: string, rows: AlertRow[], now: Date): string {
  // Section header with a thin underline divider — matches the
  // "Recent" / "All" eyebrow + underlined heading on the site.
  const parts: string[] = [];
  parts.push(
    `<tr><td style="padding:24px 0 12px 0;` +
    `border-bottom:1px solid ${COLORS.lineStrong};">` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;` +
    `color:${COLORS.fgSubtle};">${esc(title)}</div>` +
    `</td></tr>`,
  );
  parts.push(`<tr><td style="height:14px;"></td></tr>`);

  if (rows.length === 0) {
    parts.push(
      `<tr><td style="padding:0 0 14px 0;">` +
      `<div style="border:1px dashed ${COLORS.lineStrong};background:${COLORS.muted};` +
      `border-radius:8px;padding:14px 16px;` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `font-size:13px;color:${COLORS.fgSubtle};">` +
      `No new BV/HIGH roles.</div></td></tr>`,
    );
    return parts.join("");
  }

  // Group by level so BV/HIGH/MED render in priority order, with a
  // tiny eyebrow above each group.
  for (const level of ["BV", "HIGH", "MEDIUM"] as const) {
    const slice = rows.filter((r) => r.level === level);
    if (slice.length === 0) continue;
    parts.push(
      `<tr><td style="padding:4px 0 8px 0;` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;` +
      `color:${LEVEL_STYLE[level].fg};">${LEVEL_LABEL_HTML[level]}</td></tr>`,
    );
    for (const r of slice) parts.push(renderRowHtml(r, now));
  }
  return parts.join("");
}

function buildHtml(
  data: DigestData,
  now: Date,
  siteUrl: string,
  capNotice: string | null,
): string {
  const { today, yesterday } = data;
  const total = today.length + yesterday.length;

  const headline =
    total === 0
      ? "No new BV/HIGH roles in the last 48h."
      : `${total} new BV/HIGH role${total === 1 ? "" : "s"} in the last 48h ` +
        `(${today.length} today, ${yesterday.length} yesterday).`;

  const capBlock = capNotice
    ? `<tr><td style="padding:0 0 16px 0;">` +
      `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;` +
      `padding:12px 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
      `font-size:13px;line-height:1.5;color:#92400e;">${esc(capNotice)}</div>` +
      `</td></tr>`
    : "";

  const todaySection = renderSectionHtml("Today · last 24h", today, now);
  const yesterdaySection =
    yesterday.length > 0
      ? renderSectionHtml("Yesterday · 24-48h ago", yesterday, now)
      : "";

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>par job tracker</title></head>` +
    `<body style="margin:0;padding:0;background:${COLORS.canvas};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="background:${COLORS.canvas};">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="max-width:640px;">` +

    // Eyebrow + headline
    `<tr><td style="padding:0 0 6px 0;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;` +
    `color:${COLORS.fgSubtle};">Daily digest</td></tr>` +
    `<tr><td style="padding:0 0 20px 0;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:22px;font-weight:600;line-height:1.3;color:${COLORS.fg};">` +
    `${esc(headline)}</td></tr>` +

    capBlock +
    todaySection +
    yesterdaySection +

    // Footer
    `<tr><td style="padding:32px 0 0 0;border-top:1px solid ${COLORS.line};` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `font-size:12px;color:${COLORS.fgSubtle};">` +
    `<a href="${esc(siteUrl)}" style="color:${COLORS.fgMuted};text-decoration:underline;">` +
    `View all open roles</a></td></tr>` +

    `</table></td></tr></table></body></html>`
  );
}

function buildText(
  data: DigestData,
  now: Date,
  siteUrl: string,
  capNotice: string | null,
): string {
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

  // Phase 6: if the user has hit their monthly cap, surface that
  // up front. Without this note, capped users would see "pending"
  // markers on roles indefinitely and wonder why scoring stopped.
  if (capNotice) {
    lines.push(capNotice);
    lines.push("");
  }

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

// Resolve the recipient + cap notice for a user. Returns null when
// the user shouldn't get an email at all (digest_enabled=false, no
// resolvable email address). Separate from sendDigest so the cron
// route can short-circuit cheaply for opted-out users without
// composing an email body.
export type RecipientInfo = {
  to: string;
  capNotice: string | null;
};

export async function resolveRecipient(
  userId: string,
): Promise<RecipientInfo | null> {
  const db = getDb();
  const rows = await db
    .select({
      email: users.email,
      digestEnabled: userExtras.digestEnabled,
      digestEmail: userExtras.digestEmail,
      monthlyCapUsd: userExtras.monthlyCapUsd,
    })
    .from(users)
    .leftJoin(userExtras, eq(userExtras.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.digestEnabled) return null;
  const to = row.digestEmail?.trim() || row.email?.trim();
  if (!to) return null;

  // Cap notice. Use the same total-cap check the scoring path uses
  // (lib/fit/spendCaps.ts) so the email's claim of "capped" matches
  // what /docs would show.
  let capNotice: string | null = null;
  const cap = parseFloat(row.monthlyCapUsd ?? "0");
  if (cap > 0) {
    const status = await checkSpend(userId, "score");
    if (status.totalCapReached) {
      capNotice =
        `⚠️  You hit your monthly $${status.totalCap.toFixed(2)} cap ` +
        `($${status.totalSpent.toFixed(2)} used). AI scoring is paused until ` +
        `the next month rolls over. New matches will show as [pending] until then.`;
    }
  } else {
    // cap=0 (demo user, or someone the maintainer froze) — explicit
    // notice rather than silent ambiguity.
    capNotice =
      "⚠️  AI scoring is disabled for this account. New matches show as [pending].";
  }

  return { to, capNotice };
}

// Send a daily digest to one user. The cron route loops every
// onboarded user with digest_enabled=true and calls this once each;
// recipient + cap notice come from resolveRecipient(userId).
//
// Returns false on missing API key, missing recipient (user opted
// out or no email on file), or Resend error.
export async function sendDigest(
  userId: string,
  data: DigestData,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[alerts] RESEND_API_KEY not set — skipping email send");
    return false;
  }
  const from = process.env.ALERT_FROM_EMAIL;
  if (!from) {
    console.warn("[alerts] ALERT_FROM_EMAIL not set — skipping email send");
    return false;
  }

  const recipient = await resolveRecipient(userId);
  if (!recipient) {
    // Either the user has digest_enabled=false, or they have no
    // resolvable email. Either way: skip silently. The cron loop
    // counts this as "skipped, not failed."
    return false;
  }

  const siteUrl = process.env.SITE_URL ?? "(set SITE_URL in env)";

  const total = data.today.length + data.yesterday.length;

  const now = new Date();
  const resend = new Resend(apiKey);
  const { data: result, error } = await resend.emails.send({
    from,
    to: recipient.to,
    subject: buildSubject(data),
    // Both html (rich rendering, matches the site) and text (plain
    // fallback for clients that don't render HTML, and for the
    // multipart/alternative auto-generated by Resend).
    html: buildHtml(data, now, siteUrl, recipient.capNotice),
    text: buildText(data, now, siteUrl, recipient.capNotice),
  });
  if (error) {
    console.error(
      `[alerts] Resend send failed (user ${userId.slice(0, 8)}):`,
      error,
    );
    return false;
  }
  console.log(
    `[alerts] digest sent to ${recipient.to} (user ${userId.slice(0, 8)}, today=${data.today.length}, yesterday=${data.yesterday.length}, total=${total}, id=${result?.id})`,
  );
  return true;
}
