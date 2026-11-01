import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/** Catalog items a seller offers (off-chain; prices in token base units). */
export const services = pgTable("services", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  priceUnits: text("price_units").notNull(),
  deliveryHours: integer("delivery_hours").notNull(),
  active: boolean("active").notNull().default(true),
  /** Agent Environment that serves this service synchronously over A2A (e.g. "fact-checker"); null = order flow. */
  agentEnv: text("agent_env"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("services_handle").on(t.handle)]);

/** Off-chain mirror of an order + the buyer's brief. Money state is read from the `orders` contract. */
export const orders = pgTable("orders", {
  orderId: text("order_id").primaryKey(),
  handle: text("handle").notNull(),
  serviceId: text("service_id").notNull(),
  amount: text("amount").notNull(),
  brief: text("brief").notNull(),
  buyerAccountId: text("buyer_account_id"),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("orders_handle").on(t.handle), index("orders_state").on(t.state)]);

/** One checkpoint per (order, step): a step that finds its artifact does nothing (docs/swarm.md). */
export const artifacts = pgTable("artifacts", {
  orderId: text("order_id").notNull(),
  step: text("step").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orderId, t.step] })]);

/** Every ResultEnvelope a job used; billing turns these into usage records. */
export const envelopes = pgTable("envelopes", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull(),
  step: text("step").notNull(),
  accountId: text("account_id").notNull(),
  envelope: jsonb("envelope").notNull(),
  settledBatch: text("settled_batch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("envelopes_unsettled").on(t.accountId).where(sql`settled_batch is null`)]);

/** Side effects (chain calls, posts, messages) sent at most once per key (architecture.md §8). */
export const outbox = pgTable("outbox", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  result: jsonb("result"),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("outbox_key").on(t.key), index("outbox_due").on(t.state, t.nextAt)]);

/** Seller agent function-call keys and bot tokens, sealed with the gateway key (never stored in clear). */
export const sellerSecrets = pgTable("seller_secrets", {
  handle: text("handle").notNull(),
  name: text("name").notNull(),
  sealed: text("sealed").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.handle, t.name] })]);

/** Escrow payments already redeemed for an A2A task: each payment buys one task (docs/swarm.md flow 3). */
export const a2aPayments = pgTable("a2a_payments", {
  paymentId: text("payment_id").primaryKey(),
  handle: text("handle").notNull(),
  taskId: text("task_id").notNull(),
  amount: text("amount").notNull(),
  /** The delivered result: a retry with the same paid task gets it again (no double work, no lost payment). */
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------- M1: the content store (ADR 0018). Keyed by the shop handle (= its NEAR account prefix). ----------

/** A seller's business: what they sell and how AI should talk about it. */
export const businesses = pgTable("businesses", {
  handle: text("handle").primaryKey(),
  name: text("name").notNull(),
  /** products | services | both */
  kind: text("kind").notNull().default("products"),
  description: text("description").notNull().default(""),
  /** Instagram / Telegram / website links the owner gave us (read as data, never as instructions). */
  links: jsonb("links").notNull().default(sql`'[]'::jsonb`),
  language: text("language").notNull().default("en"),
  timezone: text("timezone").notNull().default("Europe/Kyiv"),
  plan: text("plan").notNull().default("free"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** "What we found": the AI's profile of the business (Boost Content `profile` shape) + facts shown while it works. */
export const profiles = pgTable("profiles", {
  handle: text("handle").primaryKey(),
  /** none | analyzing | ready | failed */
  status: text("status").notNull().default("none"),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  facts: jsonb("facts").notNull().default(sql`'[]'::jsonb`),
  /** Learned from the owner's picks and edits (likes, dislikes, voice). */
  learned: jsonb("learned").notNull().default(sql`'{}'::jsonb`),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Things a store sells: a product (shipped) or a service (done). Prices in token base units. */
export const items = pgTable("items", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  kind: text("kind").notNull().default("product"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  priceUnits: text("price_units").notNull(),
  options: jsonb("options").notNull().default(sql`'[]'::jsonb`),
  photoMediaId: text("photo_media_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("items_handle").on(t.handle)]);

/** Photos the owner uploaded and images AI made. `key` is a path under MEDIA_DIR. */
export const media = pgTable("media", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  /** photo | generated */
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  contentType: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  itemId: text("item_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("media_handle").on(t.handle)]);

/** Ways to sell more that AI found (trend, price, upsell, channel), each with an honest estimate. */
export const opportunities = pgTable("opportunities", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  why: text("why").notNull(),
  /** Estimated extra revenue per month in token base units; an estimate, never a promise. */
  estimateUnits: text("estimate_units").notNull().default("0"),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  chosen: boolean("chosen").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("opportunities_handle").on(t.handle)]);

/** A post AI made: options in a batch → the owner keeps some → scheduled → published (with a proof on NEAR). */
export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  batchId: text("batch_id").notNull(),
  /** queued | writing | rendering | ready | failed | scheduled | published */
  status: text("status").notNull().default("queued"),
  opportunityId: text("opportunity_id"),
  itemId: text("item_id"),
  idea: jsonb("idea").notNull().default(sql`'{}'::jsonb`),
  caption: text("caption"),
  hashtags: jsonb("hashtags").notNull().default(sql`'[]'::jsonb`),
  imageMediaId: text("image_media_id"),
  sourceMediaId: text("source_media_id"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /** {sha256, proofId, tx} once recorded on proof-log. */
  proof: jsonb("proof"),
  chosenAt: timestamp("chosen_at", { withTimezone: true }),
  passedAt: timestamp("passed_at", { withTimezone: true }),
  quotaMonth: text("quota_month").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("posts_handle").on(t.handle, t.createdAt), index("posts_batch").on(t.batchId)]);

/** What the owner did with AI output (chose, passed, edited, copied): feeds the learn step. */
export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(),
  postId: text("post_id"),
  kind: text("kind").notNull(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("signals_handle").on(t.handle, t.id)]);

/** Analytics events: store views, post views, clicks, orders, sales. */
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(),
  kind: text("kind").notNull(),
  postId: text("post_id"),
  itemId: text("item_id"),
  orderId: text("order_id"),
  /** Where the visitor came from (telegram, instagram, direct, …). */
  source: text("source"),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_handle").on(t.handle, t.createdAt)]);

/** Posts and images used per month, for plan limits (Boost Content's reserve/refund). */
export const usageMonthly = pgTable("usage_monthly", {
  handle: text("handle").notNull(),
  month: text("month").notNull(),
  posts: integer("posts").notNull().default(0),
  images: integer("images").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.handle, t.month] })]);

/** Admin image lab (tailnet only): one row per model render, to compare models on real product photos. */
export const labRuns = pgTable("lab_runs", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  variant: text("variant").notNull(),
  prompt: text("prompt").notNull(),
  photoKey: text("photo_key"),
  /** queued | running | done | failed */
  status: text("status").notNull().default("queued"),
  elapsedMs: integer("elapsed_ms"),
  outputKey: text("output_key"),
  error: text("error"),
  /** -1 bad, 0 unrated, 1 good, 2 best */
  rating: integer("rating").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("lab_runs_batch").on(t.batchId), index("lab_runs_created").on(t.createdAt)]);

/** Operator settings (e.g. the image model chosen in the lab). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
