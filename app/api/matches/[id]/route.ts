import { NextResponse } from "next/server";
import { setMatchStatus } from "@/db/matches";
import type { MatchStatus } from "@/db/schema";
import { getViewerUserId, requireOwner } from "@/lib/auth/viewer";

// PATCH /api/matches/{id}  body: { status: MatchStatus }
//
// Powers the per-card Applied toggle (applied/new) and × dismiss
// button (dismissed). "interested" is in the schema enum for a
// future multi-state cycle but isn't wired to UI yet.
const VALID_STATUSES: MatchStatus[] = ["new", "applied", "dismissed", "interested"];

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwner();
  if (denied) return denied;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status as MatchStatus)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const result = await setMatchStatus(userId, id, status as MatchStatus);
  if (!result) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
