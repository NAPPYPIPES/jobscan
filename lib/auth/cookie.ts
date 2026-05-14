// Edge-compatible HMAC-SHA256 session cookie. The cookie value IS the
// signature of a fixed-per-role payload — no JSON parsing of attacker-
// controlled bytes, no user identity beyond the role, no DB session
// table. Verifying tries each known role's payload via
// crypto.subtle.verify (constant-time per spec) and returns whichever
// matches, or null.
//
// Two roles today:
//   owner — the maintainer; full read + write
//   demo  — anonymous demo viewer; read-only, scoped to a curated
//           subset of companies (see lib/auth/demo-allowlist.ts)
//
// Rotating AUTH_SECRET invalidates every existing cookie (intended).

export type Role = "owner" | "demo";

const PAYLOAD: Record<Role, string> = {
  owner: "v1:authed:owner",
  demo: "v1:authed:demo",
};
const ROLES: Role[] = ["owner", "demo"];

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function signSession(secret: string, role: Role): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(PAYLOAD[role]),
  );
  return toBase64Url(sig);
}

// Try each role's payload. Returns the matching role, or null. The
// per-role verify is independent — an attacker can't substitute one
// role's signature for another, and there's nothing in the cookie
// other than the signature itself (no parsed bytes, no JWT header).
export async function verifySession(
  cookie: string,
  secret: string,
): Promise<Role | null> {
  if (!cookie) return null;
  try {
    const key = await importKey(secret);
    const sig = fromBase64Url(cookie);
    for (const role of ROLES) {
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        sig,
        new TextEncoder().encode(PAYLOAD[role]),
      );
      if (ok) return role;
    }
    return null;
  } catch {
    return null;
  }
}
