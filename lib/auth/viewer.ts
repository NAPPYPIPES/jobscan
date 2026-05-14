import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type { Role } from "./cookie";

// Server-side helpers for reading the viewer's role. The role lives
// on the request via the `x-par-role` header that middleware.ts
// writes after a successful cookie verify. Reading it here is just
// a header lookup — no HMAC re-verification per request.
//
// Defaults to 'owner' when the header is missing. The middleware
// only lets unauthenticated requests through to /login (which
// doesn't render any owner-only content), and the dev-bypass path
// also writes 'owner', so a missing header in any owner-reachable
// context is the safe assumption. Demo viewers always carry the
// explicit "demo" header value.

const HEADER = "x-par-role";

export type { Role };

export async function getViewerRole(): Promise<Role> {
  const h = await headers();
  const v = h.get(HEADER);
  if (v === "demo") return "demo";
  return "owner";
}

// Convenience for API mutation routes: returns null on success,
// returns a 403 NextResponse on failure. Callers `return result` if
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
