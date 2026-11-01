CREATE TABLE "a2a_payments" (
	"payment_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"task_id" text NOT NULL,
	"amount" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "agent_env" text;