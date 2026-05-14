// Edge-compatible HMAC-SHA256 session cookie. Single-user, single-bit
// auth: the cookie value IS the signature of a fixed payload — there's
// no user identity, no expiry baked in (the cookie's Max-Age handles
// that), no DB session table. Verifying just recomputes the HMAC from
// the same fixed payload + AUTH_SECRET and constant-time compares via
// crypto.subtle.verify.
//
// Rotating AUTH_SECRET invalidates every existing cookie (intended).

const PAYLOAD = "v1:authed";

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

export async function signSession(secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(PAYLOAD));
  return toBase64Url(sig);
}

export async function verifySession(cookie: string, secret: string): Promise<boolean> {
  if (!cookie) return false;
  try {
    const key = await importKey(secret);
    const sig = fromBase64Url(cookie);
    return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(PAYLOAD));
  } catch {
    return false;
  }
}
