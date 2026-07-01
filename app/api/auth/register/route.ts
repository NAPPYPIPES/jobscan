// Email/password sign-up endpoint — DISABLED.
//
// This is a single-user personal deployment. The maintainer signs in
// via Google (gated to MAINTAINER_EMAIL by the signIn callback in
// lib/auth/config.ts). Public self-registration is turned off, so this
// endpoint always returns 403. The /signup UI was also removed from
// app/login/page.tsx, but this hard block stops direct POSTs too.
//
// To re-enable multi-user signup, restore the create-user flow from
// git history (the version before the single-user lockdown commit).

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json({ error: "Registration is disabled." }, { status: 403 });
}
