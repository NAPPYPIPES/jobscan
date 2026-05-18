"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

// Sign-up page for new email/password accounts. POSTs to
// /api/auth/register, then redirects to /login with a success flag.
// Google sign-ups skip this page entirely — they're created
// automatically by the NextAuth Drizzle adapter on first OAuth login.

export default function SignupPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") ?? "").trim() || null,
      email: String(form.get("email") ?? "").trim().toLowerCase(),
      password: String(form.get("password") ?? ""),
    };
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Could not create account");
        setSubmitting(false);
        return;
      }
      router.push("/login?registered=1");
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md items-center px-6">
      <div className="w-full">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          pub-ats-radar
        </p>
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-fg">Create account</h1>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            name="name"
            autoComplete="name"
            placeholder="Name (optional)"
            className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[15px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
          />
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
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="Password (8+ characters)"
            className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[15px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
          />
          {error ? (
            <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-fg px-4 py-3 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-[13px] text-fg-subtle">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-fg underline-offset-2 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
