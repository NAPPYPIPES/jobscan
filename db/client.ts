import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

// Lazy so importing this module never crashes just from a missing env var
// — the error only surfaces at actual DB-call sites, where the stack is
// more useful for debugging.
export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in your Neon connection string.",
    );
  }
  const sql = neon(url);
  return drizzle(sql);
}
