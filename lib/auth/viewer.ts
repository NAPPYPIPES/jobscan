import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type { Role } from "./cookie";
import { isDemoUser } from "./maintainer";

// Server-side helpers for reading the viewer's identity. The user id
// lives on the request via the `x-par-user-id` header that
// middleware.ts writes after a successful NextAuth JWT verify.
//
// Two effective roles:
//   - "owner" — the signed-in user is operating on their own data
//                (maintainer, paying friend, etc.).
//   - "demo"  — the signed-in user is the pre-seeded DEMO_USER_ID.
//               Mutations are blocked, AI calls are blocked by the
//               $0 monthly cap on user_extras, and a banner explains
//               the demo framing.

const HEADER_USER_ID = "x-par-user-id";

export type { Role };

export async function getViewerUserId(): Promise<string | null> {
  const h = await headers();
  return h.get(HEADER_USER_ID);
}

export async function getViewerRole(): Promise<Role> {
  const userId = await getViewerUserId();
  return isDemoUser(userId) ? "demo" : "owner";
}

// Convenience for API mutation routes: returns null on success,
// returns a 403 NextResponse on demo. Callers `return result` if
// it's non-null, otherwise proceed with the mutation. Single source
// of truth for the demo block — every mutation route uses this so
// none of them can drift.
export async function requireOwner(): Promise<NextResponse | null> {
  const role = await getViewerRole();
  if (role === "owner") return null;
  return NextResponse.json(
    { error: "demo mode — read-only" },
    { status: 403 },
  );
}
