import type { Config } from "drizzle-kit";
import { config as loadEnv } from "dotenv";

// Next.js uses .env.local; drizzle-kit looks at .env by default. Load
// .env.local explicitly so `drizzle-kit generate` / `migrate` / `push`
// see DATABASE_URL without needing to duplicate the value into .env.
loadEnv({ path: ".env.local" });

export default {
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
