CREATE TABLE "follows" (
	"buyer_id" text NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_buyer_id_handle_pk" PRIMARY KEY("buyer_id","handle")
);
--> statement-breakpoint
CREATE INDEX "follows_handle" ON "follows" USING btree ("handle");