-- One-shot additive migration for an existing-DB upgrade path. Adds
-- only the four config tables (targets, manual_companies,
-- workday_tenants, personal_keywords); leaves every existing table
-- untouched.
--
-- Usage:
--   psql "$DATABASE_URL" -f drizzle/_add_config_tables.sql
--
-- Why this exists instead of `drizzle-kit push`:
-- drizzle-kit push diffs the full schema vs. the live DB. If your DB
-- carries legacy columns the current schema no longer declares (e.g.
-- a `matches.list` column from a prior internal version), drizzle
-- will propose to drop them. Some users want to defer that drop.
-- This file is the additive-only half of the migration, safe to run
-- against any prior schema.
--
-- For fresh installs, use the canonical drizzle-kit migration at
-- drizzle/0000_nervous_luminals.sql instead — that creates all
-- tables in one shot.
--
-- Filename is underscore-prefixed so drizzle-kit doesn't pick it up
-- as a tracked migration.

CREATE TABLE IF NOT EXISTS "targets" (
    "slug" text PRIMARY KEY NOT NULL,
    "ats" text NOT NULL,
    "display_name" text NOT NULL,
    "sector" text,
    "stage" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "manual_companies" (
    "name" text PRIMARY KEY NOT NULL,
    "careers_url" text NOT NULL,
    "description" text NOT NULL,
    "sector" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "workday_tenants" (
    "slug" text PRIMARY KEY NOT NULL,
    "host" text NOT NULL,
    "board" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "personal_keywords" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "bv_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "healthcare_skips" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "hard_cap_low_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "finserv_bonus_positive_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Sanity check the new tables exist + are empty:
--   SELECT to_regclass('targets'), to_regclass('manual_companies'),
--          to_regclass('workday_tenants'), to_regclass('personal_keywords');
--   SELECT count(*) FROM targets;
