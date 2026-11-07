CREATE TABLE "order_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"handle" text NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "order_messages_order" ON "order_messages" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "order_messages_handle" ON "order_messages" USING btree ("handle","created_at");