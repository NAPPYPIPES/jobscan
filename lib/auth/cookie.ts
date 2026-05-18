// Deprecated. The HMAC-cookie session has been replaced by NextAuth v5
// JWT sessions (see lib/auth/config.ts). This file is kept only so
// existing `import type { Role } from "@/lib/auth/cookie"` lines keep
// compiling during the Phase 1 cutover. It will be deleted entirely in
// Phase 7 cleanup once every caller imports from lib/auth/viewer.
//
// The runtime signSession / verifySession functions are gone — there
// are no remaining callers.

// Type kept as a union so existing `if (role === "demo") { ... }`
// branches stay type-correct during the Phase 1 cutover. At runtime
// getViewerRole() now always returns "owner", so the demo branches
// are dead code — Phase 7 cleanup deletes them.
export type Role = "owner" | "demo";
