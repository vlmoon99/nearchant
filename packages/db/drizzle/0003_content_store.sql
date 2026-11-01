CREATE TABLE "businesses" (
	"handle" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'products' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Europe/Kyiv' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"kind" text NOT NULL,
	"post_id" text,
	"item_id" text,
	"order_id" text,
	"source" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_units" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photo_media_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why" text NOT NULL,
	"estimate_units" text DEFAULT '0' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chosen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"batch_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"opportunity_id" text,
	"item_id" text,
	"idea" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"caption" text,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_media_id" text,
	"source_media_id" text,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"proof" jsonb,
	"chosen_at" timestamp with time zone,
	"passed_at" timestamp with time zone,
	"quota_month" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"handle" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"learned" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"post_id" text,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"handle" text NOT NULL,
	"month" text NOT NULL,
	"posts" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_monthly_handle_month_pk" PRIMARY KEY("handle","month")
);
--> statement-breakpoint
CREATE INDEX "events_handle" ON "events" USING btree ("handle","created_at");--> statement-breakpoint
CREATE INDEX "items_handle" ON "items" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "media_handle" ON "media" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "opportunities_handle" ON "opportunities" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "posts_handle" ON "posts" USING btree ("handle","created_at");--> statement-breakpoint
CREATE INDEX "posts_batch" ON "posts" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "signals_handle" ON "signals" USING btree ("handle","id");