CREATE TABLE "lab_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"variant" text NOT NULL,
	"prompt" text NOT NULL,
	"photo_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"elapsed_ms" integer,
	"output_key" text,
	"error" text,
	"rating" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lab_runs_batch" ON "lab_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "lab_runs_created" ON "lab_runs" USING btree ("created_at");