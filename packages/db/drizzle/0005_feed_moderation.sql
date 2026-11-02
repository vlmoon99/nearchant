CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "admin_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"wallet" text,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"banned_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_vectors" (
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"handle" text NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_vectors_kind_ref_id_pk" PRIMARY KEY("kind","ref_id")
);
--> statement-breakpoint
CREATE TABLE "ip_log" (
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"ip" text NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_log_subject_kind_subject_id_ip_pk" PRIMARY KEY("subject_kind","subject_id","ip")
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"buyer_id" text NOT NULL,
	"post_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_buyer_id_post_id_pk" PRIMARY KEY("buyer_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_kind" text NOT NULL,
	"post_id" text,
	"handle" text NOT NULL,
	"reporter_buyer_id" text,
	"reporter_ip" text,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"ai" jsonb,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "violations" (
	"id" serial PRIMARY KEY NOT NULL,
	"violator_id" integer NOT NULL,
	"post_id" text,
	"report_id" integer,
	"category" text NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"by" text NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "violators" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "ships" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "place_by" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "moderation" jsonb;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "removed_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_email" ON "buyers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "buyers_wallet" ON "buyers" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "content_vectors_hnsw" ON "content_vectors" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "likes_post" ON "likes" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "reports_status" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_post" ON "reports" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "violations_violator" ON "violations" USING btree ("violator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "violators_subject" ON "violators" USING btree ("subject_kind","subject_id");