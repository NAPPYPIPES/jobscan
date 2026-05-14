ALTER TABLE "matches" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "last_success_at" timestamp with time zone;