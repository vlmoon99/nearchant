import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, index, uniqueIndex, vector } from "drizzle-orm/pg-core";

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
  /** Where the store is and where it ships (ADR 0022): city name, ISO 3166-1 alpha-2, local | country | world. */
  city: text("city"),
  country: text("country"),
  ships: text("ships"),
  /** owner | ai — who set the place (an owner's choice is never overwritten by the AI). */
  placeBy: text("place_by"),
  /** Set when moderation suspends the store (hidden from the feed and its page). */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
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
  /** Latest moderation verdict (ADR 0022) and, when removed, when and why (never shown publicly again). */
  moderation: jsonb("moderation"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedReason: text("removed_reason"),
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

/** Buyer accounts (ADR 0022): signed in by email link or a NEAR wallet (NEP-413). */
export const buyers = pgTable("buyers", {
  id: text("id").primaryKey(),
  email: text("email"),
  wallet: text("wallet"),
  name: text("name"),
  /** active | banned */
  status: text("status").notNull().default("active"),
  bannedReason: text("banned_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("buyers_email").on(t.email), uniqueIndex("buyers_wallet").on(t.wallet)]);

export const likes = pgTable("likes", {
  buyerId: text("buyer_id").notNull(),
  postId: text("post_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.buyerId, t.postId] }), index("likes_post").on(t.postId)]);

/** Buyer reports of a post or a store; the moderator agent decides first, a human can change it. */
export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  /** post | store */
  targetKind: text("target_kind").notNull(),
  postId: text("post_id"),
  handle: text("handle").notNull(),
  reporterBuyerId: text("reporter_buyer_id"),
  reporterIp: text("reporter_ip"),
  /** scam | illegal | sexual | violence | hate | counterfeit | spam | other */
  reason: text("reason").notNull(),
  note: text("note").notNull().default(""),
  /** open | auto_removed | auto_kept | removed | kept */
  status: text("status").notNull().default("open"),
  ai: jsonb("ai"),
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("reports_status").on(t.status, t.createdAt), index("reports_post").on(t.postId)]);

/** Accounts that broke the rules: who is who (NEAR accounts, emails, IPs) for future cases (ADR 0022). */
export const violators = pgTable("violators", {
  id: serial("id").primaryKey(),
  /** store | buyer */
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  count: integer("count").notNull().default(0),
  accounts: jsonb("accounts").notNull().default(sql`'[]'::jsonb`),
  emails: jsonb("emails").notNull().default(sql`'[]'::jsonb`),
  ips: jsonb("ips").notNull().default(sql`'[]'::jsonb`),
  notes: text("notes").notNull().default(""),
  firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("violators_subject").on(t.subjectKind, t.subjectId)]);

/** One moderation decision (by the agent or a person); undone ones keep their row. */
export const violations = pgTable("violations", {
  id: serial("id").primaryKey(),
  violatorId: integer("violator_id").notNull(),
  postId: text("post_id"),
  reportId: integer("report_id"),
  category: text("category").notNull(),
  confidence: integer("confidence").notNull().default(0),
  summary: text("summary").notNull().default(""),
  by: text("by").notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: text("undone_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("violations_violator").on(t.violatorId)]);

/** IPs seen per account (sign-in, posting, liking, reporting), kept 180 days — for the violators list only. */
export const ipLog = pgTable("ip_log", {
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id").notNull(),
  ip: text("ip").notNull(),
  n: integer("n").notNull().default(1),
  firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.subjectKind, t.subjectId, t.ip] })]);

/** Search vectors for public text (post caption, item, store) — Qwen3-Embedding-0.6B, 1024 dims (ADR 0022). */
export const contentVectors = pgTable("content_vectors", {
  /** post | item | store */
  kind: text("kind").notNull(),
  refId: text("ref_id").notNull(),
  handle: text("handle").notNull(),
  textHash: text("text_hash").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.kind, t.refId] }), index("content_vectors_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops"))]);

/** Every admin action (who, what, on what). */
export const adminLog = pgTable("admin_log", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Buyers following stores (ADR 0022): a Following feed, and followed stores rank higher in "For you". */
export const follows = pgTable("follows", {
  buyerId: text("buyer_id").notNull(),
  handle: text("handle").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.buyerId, t.handle] }), index("follows_handle").on(t.handle)]);

/** Shop-feed searches, anonymous (no IP, no account): what shoppers want, for sellers' Analytics (ADR 0022). */
export const searchLog = pgTable("search_log", {
  id: serial("id").primaryKey(),
  q: text("q").notNull(),
  goods: jsonb("goods").notNull().default(sql`'[]'::jsonb`),
  city: text("city"),
  country: text("country"),
  results: integer("results").notNull().default(0),
  /** Stores whose posts were in the first page of results. */
  handles: jsonb("handles").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("search_log_created").on(t.createdAt)]);
