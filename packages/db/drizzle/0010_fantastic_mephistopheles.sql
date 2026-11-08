ALTER TABLE "items" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "held" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "contact" jsonb;