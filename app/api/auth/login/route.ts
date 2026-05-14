import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { signSession } from "@/lib/auth/cookie";

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

export async function POST(req: Request) {
  const form = await req.formData();
  const submitted = String(form.get("password") ?? "");
  const expected = process.env.PERSONAL_PASS ?? "";
  const secret = process.env.AUTH_SECRET ?? "";
  if (!expected || !secret) {
    console.error("[auth] PERSONAL_PASS or AUTH_SECRET not set — refusing login");
    return NextResponse.redirect(new URL("/login?error=1", req.url), { status: 303 });
  }
  if (!eqConstTime(submitted, expected)) {
    return NextResponse.redirect(new URL("/login?error=1", req.url), { status: 303 });
  }
  const value = await signSession(secret);
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
