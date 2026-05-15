-- Migration: two-tier (Haiku triage + Sonnet deep-score) pipeline.
-- Adds Tier-1 columns to matches, a pending-BV-verification flag,
-- Sonnet's BV reasoning column, and a new scoring_caps table for
-- user-configurable cost controls.
--
-- Idempotent — every statement uses IF NOT EXISTS so re-runs are safe.
-- Applied via scripts/apply-migration-0002.ts (same pattern as 0001).

ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_score" numeric(3, 1);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_confidence" text;
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_is_potential_bv" boolean;
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "tier1_quick_take" text;
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "pending_bv_verification" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "bv_reasoning" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoring_caps" (
    "key" text PRIMARY KEY DEFAULT 'default',
    "config" jsonb NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
