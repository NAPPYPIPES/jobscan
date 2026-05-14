CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"match_id" uuid,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" numeric(8, 6) NOT NULL,
	"model" text NOT NULL,
	"purpose" text DEFAULT 'score' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"slug" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_date" date NOT NULL,
	CONSTRAINT "manual_checks_company_date_unique" UNIQUE("company","check_date")
);
--> statement-breakpoint
CREATE TABLE "manual_companies" (
	"name" text PRIMARY KEY NOT NULL,
	"careers_url" text NOT NULL,
	"description" text NOT NULL,
	"sector" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ats" text NOT NULL,
	"company_slug" text NOT NULL,
	"company_display_name" text NOT NULL,
	"job_id" text NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"location" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"applied_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text[],
	"fit_score" numeric(3, 1),
	"fit_summary" text,
	"fit_flag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_ats_slug_jobid_unique" UNIQUE("ats","company_slug","job_id")
);
--> statement-breakpoint
CREATE TABLE "personal_keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bv_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"healthcare_skips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hard_cap_low_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finserv_bonus_positive_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_summaries" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"pros" jsonb NOT NULL,
	"cons" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(8, 6)
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"slug" text PRIMARY KEY NOT NULL,
	"ats" text NOT NULL,
	"display_name" text NOT NULL,
	"sector" text,
	"stage" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_resume_md" text NOT NULL,
	"parsed_summary" text NOT NULL,
	"years_experience" integer,
	"industries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"functions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seniority_level" text,
	"target_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hard_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workday_tenants" (
	"slug" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"board" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_summaries" ADD CONSTRAINT "role_summaries_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_usage_called_at_idx" ON "api_usage" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "manual_checks_check_date_idx" ON "manual_checks" USING btree ("check_date");