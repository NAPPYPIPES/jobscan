import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfigEdge } from "@/lib/auth/config.edge";

// Auth gate. Replaces the prior HMAC-cookie + role-header system with
// NextAuth v5's JWT session. The Edge runtime decodes the JWT via the
// Auth.js secret (env AUTH_SECRET) — no DB call needed in middleware.
//
// On success: forwards the user id on the `x-par-user-id` request
// header so server components and API routes can scope reads/writes
// to the current user via headers().
//
// Bypassed routes (see matcher below):
//   /api/cron/*           — guarded by CRON_SECRET bearer
//   /api/auth/*           — NextAuth's own sign-in / callback / etc.
//   /login, /signup       — the auth UI itself
//   /_next/static, ...    — build assets
//
// Onboarding redirect (new users who haven't finished the wizard) is
// NOT enforced here — middleware can't hit the DB on Edge to check
// user_extras.onboarding_completed_at. Instead, app/layout.tsx runs a
// server-side check and redirects to /onboarding when needed.

const { auth } = NextAuth(authConfigEdge);

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl);
    return NextResponse.redirect(loginUrl);
  }
  const userId = (req.auth.user as { id?: string } | undefined)?.id;
  const requestHeaders = new Headers(req.headers);
  if (userId) requestHeaders.set("x-par-user-id", userId);
  // Forward the pathname so the root layout can decide whether to
  // bounce a new user to /onboarding (layouts can't see the URL via
  // Next.js's headers() helper without this).
  requestHeaders.set("x-par-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
});

export const config = {
  matcher: [
    // Run on everything EXCEPT:
    //  - /api/cron/*       (already guarded by CRON_SECRET bearer token)
    //  - /api/auth/*       (NextAuth's own endpoints; manages its own auth)
    //  - /login, /signup   (the auth UI itself)
    //  - /_next/static/*   (build assets)
    //  - /_next/image/*    (image optimizer)
    //  - /favicon*         (favicon requests)
    "/((?!api/cron|api/auth|login|signup|_next/static|_next/image|favicon).*)",
  ],
};
