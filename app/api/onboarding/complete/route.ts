// POST /api/onboarding/complete
// Body: { digestEnabled: boolean, digestEmail: string | null }
//
// Final step of the wizard. Saves the user's digest preferences, then
// flips user_extras.onboarding_completed_at to now() — the layout's
// onboarding redirect reads that flag and lets the user into the rest
// of the app from here on.

import { NextResponse } from "next/server";
import { getViewerUserId } from "@/lib/auth/viewer";
import { setDigestPreferences, markOnboardingComplete } from "@/db/user-extras";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await getViewerUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { digestEnabled?: unknown; digestEmail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const digestEnabled = body.digestEnabled === true;
  const digestEmail =
    typeof body.digestEmail === "string" && body.digestEmail.trim().length > 0
      ? body.digestEmail.trim().toLowerCase()
      : null;

  if (digestEnabled && !digestEmail) {
    return NextResponse.json(
      { error: "digestEmail required when digestEnabled is true" },
      { status: 400 },
    );
  }
  if (digestEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(digestEmail)) {
    return NextResponse.json({ error: "Invalid digestEmail" }, { status: 400 });
  }

  await setDigestPreferences(userId, { digestEnabled, digestEmail });
  await markOnboardingComplete(userId);

  return NextResponse.json({ ok: true });
}
