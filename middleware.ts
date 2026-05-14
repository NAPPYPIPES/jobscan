import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/cookie";

// Auth + role gate. If the session cookie is missing or doesn't verify
// against AUTH_SECRET, redirect to /login. On success, propagate the
// resolved role (owner | demo) to downstream handlers via the
// `x-par-role` request header — server components + API routes read
// that via headers() to branch behavior cheaply, without re-running
// HMAC verification per request.
//
// Cron and login endpoints are bypassed via the matcher below.
//
// Failure modes:
//   - AUTH_SECRET unset in production → fail closed (redirect to /login;
//     login also won't work since PERSONAL_PASS is presumably also unset,
//     so the site is inaccessible until both are set — intentional).
//   - AUTH_SECRET unset in dev → fail open with a warning so local dev
//     isn't blocked before the env vars are wired up. Treats the dev-
//     bypass viewer as 'owner' so all features remain reachable.
export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[auth] AUTH_SECRET not set — middleware bypassing in dev");
      const res = NextResponse.next();
      res.headers.set("x-par-role", "owner");
      return res;
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const cookie = req.cookies.get("par_session")?.value ?? "";
  const role = await verifySession(cookie, secret);
  if (!role) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  // Setting the header on the *request* (not the response) makes it
  // visible to server components and route handlers via headers(),
  // which is what we want. NextResponse.next({ request: { headers } })
  // is the documented way to mutate request headers from middleware.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-par-role", role);
  return NextResponse.next({ request: { headers: requestHeaders } });
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
