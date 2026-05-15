"use server";

// Server actions for /docs interactive controls. Right now: updating
// the scoring caps via the Settings UI. Demo viewers are rejected
// server-side (belt-and-suspenders — the UI also hides the save button
// for demo role, but a crafted POST shouldn't bypass).

import { revalidatePath } from "next/cache";
import { getViewerRole } from "@/lib/auth/viewer";
import { replaceScoringCaps } from "@/db/scoring-caps";
import type { ScoringCaps } from "@/lib/config/scoring-caps-types";

export async function updateScoringCapsAction(
  caps: ScoringCaps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const role = await getViewerRole();
  if (role === "demo") {
    return { ok: false, error: "Demo viewer — read-only access" };
  }

  try {
    await replaceScoringCaps(caps);
    revalidatePath("/docs");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
