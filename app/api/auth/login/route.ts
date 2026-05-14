import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { signSession, type Role } from "@/lib/auth/cookie";

// Node runtime so timingSafeEqual is available. The middleware's
// verify path stays on Edge — crypto.subtle.verify is constant-time
// per spec and doesn't need this runtime.
export const runtime = "nodejs";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function eqConstTime(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Resolve the submitted password to a role. Owner check first because
// it's the more sensitive credential; demo check runs unconditionally
// (not gated on owner failing) so the comparisons take the same time
// regardless of which password the user submitted — protects against
// timing-distinguishing the two paths.
function resolveRole(submitted: string): Role | null {
  const ownerExpected = process.env.PERSONAL_PASS ?? "";
  const demoExpected = process.env.DEMO_PASS ?? "";
  let matched: Role | null = null;
  if (ownerExpected && eqConstTime(submitted, ownerExpected)) matched = "owner";
  if (demoExpected && eqConstTime(submitted, demoExpected) && matched === null) {
    matched = "demo";
  }
  return matched;
}

export async function POST(req: Request) {
  const form = await req.formData();
  const submitted = String(form.get("password") ?? "");
  const secret = process.env.AUTH_SECRET ?? "";
  if (!secret) {
    console.error("[auth] AUTH_SECRET not set — refusing login");
    return NextResponse.redirect(new URL("/login?error=1", req.url), { status: 303 });
  }
  const role = resolveRole(submitted);
  if (!role) {
    return NextResponse.redirect(new URL("/login?error=1", req.url), { status: 303 });
  }
  const value = await signSession(secret, role);
  const res = NextResponse.redirect(new URL("/", req.url), { status: 303 });
  // secure: false in dev so the cookie sets over plain http://localhost.
  // In production (Vercel) every request is HTTPS so secure: true is fine.
  res.cookies.set("par_session", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
  return res;
}
