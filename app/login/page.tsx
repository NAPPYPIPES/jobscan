export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const hasError = sp.error === "1";
  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md items-center px-6">
      <div className="w-full">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
          pub-ats-radar
        </p>
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-fg">
          Sign in
        </h1>
        <form
          action="/api/auth/login"
          method="POST"
          className="flex flex-col gap-3"
        >
          <input
            type="password"
            name="password"
            autoFocus
            required
            placeholder="Passphrase"
            className="rounded-lg border border-line-strong bg-input px-4 py-3 text-[15px] text-fg placeholder:text-fg-faint focus:border-fg focus:outline-none"
          />
          {hasError ? (
            <p className="text-[13px] text-rose-600 dark:text-rose-400">Wrong passphrase.</p>
          ) : null}
          <button
            type="submit"
            className="rounded-lg bg-fg px-4 py-3 text-[14px] font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
