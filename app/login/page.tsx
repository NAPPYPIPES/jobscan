import { signIn } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

async function signInGoogle() {
  "use server";
  await signIn("google", { redirectTo: "/" });
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  // A failed signIn callback (non-maintainer Google account) sends the
  // user back here with ?error=AccessDenied.
  const errorMessage = sp.error
    ? "That account isn't authorized for this deployment."
    : null;

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md items-center px-6">
      <div className="w-full">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          pub-ats-radar
        </p>
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-fg">Sign in</h1>

        {errorMessage ? (
          <p className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-[13px] text-rose-700 dark:text-rose-300">
            {errorMessage}
          </p>
        ) : null}

        <form action={signInGoogle}>
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-canvas px-4 py-3 text-[14px] font-medium text-fg transition-colors hover:bg-elevated"
          >
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
