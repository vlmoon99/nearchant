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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
