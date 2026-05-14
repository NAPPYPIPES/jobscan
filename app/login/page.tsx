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
        <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-stone-400">
          pub-ats-radar
        </p>
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-stone-900">
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
            className="rounded-lg border border-stone-300 bg-white px-4 py-3 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none"
          />
          {hasError ? (
            <p className="text-[13px] text-red-600">Wrong passphrase.</p>
          ) : null}
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-4 py-3 text-[14px] font-medium text-white hover:bg-stone-800"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
