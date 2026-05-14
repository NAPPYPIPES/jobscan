import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/cookie";

// Single-user gate. If the session cookie is missing or doesn't verify
// against AUTH_SECRET, redirect to /login. Cron and login endpoints are
// bypassed via the matcher below.
//
// Failure modes:
//   - AUTH_SECRET unset in production → fail closed (redirect to /login;
//     login also won't work since PERSONAL_PASS is presumably also unset,
//     so the site is inaccessible until both are set — intentional).
//   - AUTH_SECRET unset in dev → fail open with a warning so local dev
//     isn't blocked before the env vars are wired up.
export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[auth] AUTH_SECRET not set — middleware bypassing in dev");
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const cookie = req.cookies.get("par_session")?.value ?? "";
  if (await verifySession(cookie, secret)) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: [
    // Run on everything EXCEPT:
    //  - /api/cron/*       (already guarded by CRON_SECRET bearer token)
    //  - /api/auth/login   (the login POST itself)
    //  - /login            (the login page)
    //  - /_next/static/*   (build assets)
    //  - /_next/image/*    (image optimizer)
    //  - /favicon*         (favicon requests)
    "/((?!api/cron|api/auth/login|login|_next/static|_next/image|favicon).*)",
  ],
};
