// NextAuth v5 route handler. Mounts /api/auth/* (sign-in, callback,
// sign-out, csrf, providers, etc.) by re-exporting the handlers from
// lib/auth/config.ts. This file is intentionally minimal — all auth
// behavior lives in the central config.

import { handlers } from "@/lib/auth/config";

export const { GET, POST } = handlers;

// We use the Node runtime so bcryptjs and the Drizzle adapter work
// during sign-in / callback. Middleware stays on Edge (sees only the
// JWT, no DB or bcrypt access needed).
export const runtime = "nodejs";
