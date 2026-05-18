import Link from "next/link";
import { signIn } from "@/lib/auth/config";
import { AuthError } from "next-auth";

export const dynamic = "force-dynamic";

async function signInGoogle() {
  "use server";
  await signIn("google", { redirectTo: "/" });
}

async function signInDemo() {
  "use server";
  // Click-through demo — the "demo" Credentials provider in
  // lib/auth/config.ts authorizes anyone as the pre-seeded demo
  // user. Mutations are blocked server-side; the layout shows a
  // persistent banner.
  await signIn("demo", { redirectTo: "/" });
}

async function signInCredentials(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (err) {
    // NextAuth throws a redirect on success — only catch AuthError.
    if (err instanceof AuthError) {
      const { redirect } = await import("next/navigation");
      redirect("/login?error=credentials");
    }
    throw err;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; registered?: string }>;
}) {
  const sp = await searchParams;
  const errorMessage =
    sp.error === "credentials"
      ? "Wrong email or password."
      : sp.error
        ? "Sign-in failed. Try again."
        : null;
  const justRegistered = sp.registered === "1";

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md items-center px-6">
      <div className="w-full">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          pub-ats-radar
        </p>
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-fg">Sign in</h1>

        {justRegistered ? (
          <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-[13px] text-emerald-700 dark:text-emerald-300">
            Account created. Sign in to continue.
          </p>
        ) : null}

        <form action={signInGoogle} className="mb-6">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-canvas px-4 py-3 text-[14px] font-medium text-fg transition-colors hover:bg-elevated"
          >
            Continue with Google
          </button>
        </form>

        <div className="mb-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>

        <form action={signInCredentials} className="flex flex-col gap-3">
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            placeholder="Email"
            className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[15px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
          />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            placeholder="Password"
            className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[15px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
          />
          {errorMessage ? (
            <p className="text-[13px] text-rose-600 dark:text-rose-400">{errorMessage}</p>
          ) : null}
          <button
            type="submit"
            className="rounded-lg bg-fg px-4 py-3 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-[13px] text-fg-subtle">
          New here?{" "}
          <Link href="/signup" className="font-medium text-fg underline-offset-2 hover:underline">
            Create an account
          </Link>
        </p>

        <div className="mt-6 border-t border-line pt-6 text-center">
          <p className="mb-3 text-[12px] text-fg-faint">
            Just want to look around?
          </p>
          <form action={signInDemo}>
            <button
              type="submit"
              className="text-[13px] font-medium text-fg underline-offset-2 hover:underline"
            >
              See the demo (no signup) →
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
