// NextAuth v5 (Auth.js) full configuration — Node runtime. Pairs with
// lib/auth/config.edge.ts (the Edge-safe slice the middleware imports).
//
// Two providers:
//   - Google OAuth: for friends signing up with their Google account.
//   - Credentials: email + bcrypt password. Sign-up creates the row via
//     /api/auth/register (see app/api/auth/register/route.ts); sign-in
//     verifies against user_extras.password_hash here.
//
// Session strategy is JWT (not DB) so middleware can verify session on
// the Edge runtime. The Drizzle adapter is still wired up because
// Google OAuth sign-ins need to insert into users + accounts tables.
//
// Maintainer linkage: the seeded maintainer row (lib/auth/maintainer.ts)
// has email = MAINTAINER_EMAIL. When Luke first signs in with Google
// using that email, allowDangerousEmailAccountLinking=true links the
// new Google account to the existing user row instead of throwing
// OAuthAccountNotLinkedError. Safe for Google because Google verifies
// emails before issuing OAuth tokens.

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users, accounts, sessions, verificationTokens, userExtras } from "@/db/schema";
import { authConfigEdge } from "@/lib/auth/config.edge";
import { MAINTAINER_EMAIL } from "@/lib/auth/maintainer";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfigEdge,
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  callbacks: {
    // Preserve the jwt/session callbacks defined on the edge config
    // (the spread above brings them in, but declaring `callbacks` here
    // would otherwise replace the whole object — so re-spread them).
    ...authConfigEdge.callbacks,
    // Single-user lockdown: only the maintainer may sign in. This is a
    // public deployment, and without this guard anyone with a Google
    // account could create their own account (and spend Anthropic
    // credits). The Credentials + demo providers set their own identity
    // internally, so we only gate the Google (OAuth) provider by email.
    async signIn({ account, profile, user }) {
      if (account?.provider !== "google") return true;
      const email = (profile?.email ?? user?.email ?? "").toLowerCase();
      return email === MAINTAINER_EMAIL.toLowerCase();
    },
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Always show the Google account chooser instead of silently
      // reusing whatever account the browser is already signed into —
      // otherwise a logged-in Google session picks the wrong account
      // with no way to switch.
      authorization: { params: { prompt: "select_account" } },
      // Link Google sign-ins to existing users by email. Safe for Google
      // because Google verifies emails; the maintainer row is seeded
      // with email = MAINTAINER_EMAIL and gets linked on first login.
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        const email = typeof creds?.email === "string" ? creds.email.trim().toLowerCase() : "";
        const password = typeof creds?.password === "string" ? creds.password : "";
        if (!email || !password) return null;

        const db = getDb();
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            image: users.image,
            passwordHash: userExtras.passwordHash,
          })
          .from(users)
          .leftJoin(userExtras, eq(userExtras.userId, users.id))
          .where(eq(users.email, email))
          .limit(1);
        const user = rows[0];
        if (!user || !user.passwordHash) return null;
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
    // "Try the demo" provider — no credentials required. Anyone who
    // POSTs to /api/auth/callback/demo (or clicks the login-page
    // button that triggers it) is signed in as the pre-seeded demo
    // user. The demo user has monthly_cap=0 (no AI spend) and is
    // blocked from mutations by requireOwner() in lib/auth/viewer.ts.
    Credentials({
      id: "demo",
      name: "Demo",
      credentials: {},
      async authorize() {
        // Single-user lockdown: demo access is disabled on this personal
        // deployment. Returning null rejects the sign-in even if someone
        // POSTs to /api/auth/callback/demo directly (the UI button is
        // also removed from app/login/page.tsx).
        return null;
      },
    }),
  ],
});
