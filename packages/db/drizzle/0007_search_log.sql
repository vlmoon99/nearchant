CREATE TABLE "search_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"q" text NOT NULL,
	"goods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"city" text,
	"country" text,
	"results" integer DEFAULT 0 NOT NULL,
	"handles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "search_log_created" ON "search_log" USING btree ("created_at");