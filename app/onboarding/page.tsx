import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  userProfile,
  userTargets,
  userManualCompanies,
  atsCatalog,
  manualCompanies,
  users,
} from "@/db/schema";
import { getUserExtras, ensureUserExtras } from "@/db/user-extras";
import OnboardingWizard, {
  type OnboardingInitialState,
  type SelectedTarget,
} from "./_components/onboarding-wizard";

export const dynamic = "force-dynamic";

// New-user onboarding wizard. Three steps: resume, targets, digest.
// Each step persists progress on submit, so a mid-flow reload picks
// up where the user left off.
//
// The layout (app/layout.tsx) redirects every authenticated route
// here while user_extras.onboarding_completed_at is null; the final
// step of the wizard flips that timestamp, after which subsequent
// navigation lands on / normally.

export default async function OnboardingPage() {
  const h = await headers();
  const userId = h.get("x-par-user-id");
  if (!userId) redirect("/login");

  // ensureUserExtras is also called in the root layout; the duplicate
  // call here is cheap (single INSERT … ON CONFLICT DO NOTHING) and
  // makes /onboarding safe to hit directly without a layout pass.
  await ensureUserExtras(userId);
  const extras = await getUserExtras(userId);

  // If they're already onboarded, kick back to /. Catches the case
  // where the user re-types the URL after finishing.
  if (extras?.onboardingCompletedAt) redirect("/");

  const db = getDb();

  // Step-1 prefill: any saved resume?
  const profileRows = await db
    .select({ rawResumeMd: userProfile.rawResumeMd })
    .from(userProfile)
    .where(eq(userProfile.userId, userId))
    .limit(1);
  const initialResume = profileRows[0]?.rawResumeMd ?? "";

  // Step-2 prefill: targets the user has already added (joined to
  // ats_catalog so we can show the canonical name in the chip).
  const targetRows = await db
    .select({
      slug: userTargets.targetSlug,
      canonicalName: atsCatalog.canonicalName,
    })
    .from(userTargets)
    .leftJoin(atsCatalog, eq(atsCatalog.slug, userTargets.targetSlug))
    .where(eq(userTargets.userId, userId));
  const initialTargets: SelectedTarget[] = targetRows.map((r) => ({
    kind: "supported",
    identifier: r.slug,
    label: r.canonicalName ?? r.slug,
  }));

  // Step-2 prefill: manual check-ins the user has already added.
  const manualRows = await db
    .select({ name: userManualCompanies.manualCompanyName })
    .from(userManualCompanies)
    .where(eq(userManualCompanies.userId, userId));
  const initialManual: SelectedTarget[] = manualRows.map((r) => ({
    kind: "manual",
    identifier: r.name,
    label: r.name,
  }));

  // Step-3 prefill: digest email defaults to the user's auth email.
  const userRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const authEmail = userRows[0]?.email ?? "";

  const initial: OnboardingInitialState = {
    resumeMd: initialResume,
    targets: initialTargets,
    manual: initialManual,
    digestEnabled: extras?.digestEnabled ?? true,
    digestEmail: extras?.digestEmail ?? authEmail,
  };

  // Silence unused-import warnings; manualCompanies + and are exposed
  // via the schema barrel but aren't queried here (kept for any
  // future inline join we might add).
  void manualCompanies;
  void and;

  return <OnboardingWizard initial={initial} />;
}
