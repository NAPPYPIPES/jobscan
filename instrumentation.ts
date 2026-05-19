// Next.js root instrumentation hook. Called once per server runtime
// instance (per Vercel cold start) before any request is handled.
//
// We register process-level handlers for unhandledRejection and
// uncaughtException so that an error escaping the request context —
// e.g. a fire-and-forget Promise inside an ATS adapter that rejects
// after the catch block has already returned — produces a forensic log
// line instead of a silent 500 with an empty body. Without this, the
// only signal we get on Vercel free-tier (30 min log retention) is a
// "Function returned 500" platform record with no stack.
//
// We deliberately do NOT call process.exit(). Vercel manages the worker
// lifecycle; killing the process here would kick out healthy in-flight
// requests sharing the same instance.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  process.on("unhandledRejection", (reason) => {
    const name = reason instanceof Error ? reason.name : "UnhandledRejection";
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    console.error(
      `[instrumentation] unhandledRejection — ${name}: ${message}\n${stack ?? "(no stack)"}`,
    );
  });

  process.on("uncaughtException", (err) => {
    console.error(
      `[instrumentation] uncaughtException — ${err.name}: ${err.message}\n${err.stack ?? "(no stack)"}`,
    );
  });
}
