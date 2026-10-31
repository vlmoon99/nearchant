CREATE TABLE "artifacts" (
	"order_id" text NOT NULL,
	"step" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_order_id_step_pk" PRIMARY KEY("order_id","step")
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"step" text NOT NULL,
	"account_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"settled_batch" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"service_id" text NOT NULL,
	"amount" text NOT NULL,
	"brief" text NOT NULL,
	"buyer_account_id" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_secrets" (
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"sealed" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_secrets_handle_name_pk" PRIMARY KEY("handle","name")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"price_units" text NOT NULL,
	"delivery_hours" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "envelopes_unsettled" ON "envelopes" USING btree ("account_id") WHERE settled_batch is null;--> statement-breakpoint
CREATE INDEX "orders_handle" ON "orders" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "orders_state" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_key" ON "outbox" USING btree ("key");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" USING btree ("state","next_at");--> statement-breakpoint
CREATE INDEX "services_handle" ON "services" USING btree ("handle");