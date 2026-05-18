// Email/password sign-up endpoint. NextAuth's Credentials provider
// only authenticates existing users — it doesn't create them — so we
// own the create-user-with-hashed-password flow here.
//
// Flow:
//   1. POST email + password + (optional) name.
//   2. Reject if email already exists.
//   3. Insert into users + user_extras (with bcrypt hash).
//   4. Caller redirects to /login or programmatically calls signIn().
//
// We DON'T auto-sign-in from this endpoint. Two reasons: (a) doing it
// server-side requires generating a session cookie that NextAuth would
// rather mint via its own flow; (b) it's simpler to redirect to /login
// and let the user submit the same credentials they just registered
// with, which exercises the live auth path.

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users, userExtras } from "@/db/schema";

export const runtime = "nodejs";

const MIN_PW_LENGTH = 8;

export async function POST(req: Request) {
  let body: { email?: unknown; password?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : null;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }
  if (password.length < MIN_PW_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PW_LENGTH} characters` },
      { status: 400 },
    );
  }

  const db = getDb();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]) {
    // Don't disclose which credential is the problem to anonymous
    // callers — keep the surface small.
    return NextResponse.json({ error: "Could not create account" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const inserted = await db
    .insert(users)
    .values({ email, name })
    .returning({ id: users.id });
  const userId = inserted[0]?.id;
  if (!userId) {
    return NextResponse.json({ error: "Could not create account" }, { status: 500 });
  }

  await db.insert(userExtras).values({
    userId,
    passwordHash,
    digestEmail: email,
  });

  return NextResponse.json({ ok: true });
}
