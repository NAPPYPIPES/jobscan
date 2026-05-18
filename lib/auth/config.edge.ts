// Edge-safe slice of the NextAuth config. Middleware (which runs on
// the Edge runtime) imports THIS file, not lib/auth/config.ts — that
// one pulls in the Drizzle adapter (which imports neon-http) and the
// Credentials provider (which imports bcryptjs). Those work in Node
// but balloon the Edge bundle and could trip Edge restrictions.
//
// The Edge config still knows the JWT secret + cookie name + session
// strategy, which is everything `auth()` needs in middleware to decode
// the existing JWT. It deliberately has NO providers, NO adapter,
// NO callbacks that touch the DB.
//
// IMPORTANT: keep this file pure-JS and dependency-light. Anything
// imported here ships to every Edge route.

import type { NextAuthConfig } from "next-auth";

export const authConfigEdge: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  trustHost: true,
  callbacks: {
    // Mirrors lib/auth/config.ts callbacks so the JWT shape the
    // middleware reads is the same shape the route handler signs.
    async jwt({ token, user }) {
      if (user) token.userId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = String(token.userId);
      }
      return session;
    },
  },
};
