import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import type { OrderRow, OrderState, Service, Store } from "./store.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface Connection {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function connect(url: string, opts: { max?: number } = {}): Connection {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end({ timeout: 5 }) };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
}

const toOrder = (r: typeof schema.orders.$inferSelect): OrderRow => ({
  orderId: r.orderId, handle: r.handle, serviceId: r.serviceId, amount: r.amount, brief: r.brief,
  buyerAccountId: r.buyerAccountId, state: r.state as OrderState, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  async listServices(handle: string): Promise<Service[]> {
    return this.db.select().from(schema.services).where(and(eq(schema.services.handle, handle), eq(schema.services.active, true))).orderBy(schema.services.createdAt)
      .then((rows) => rows.map(({ createdAt: _, ...s }) => s));
  }
  async getService(handle: string, id: string): Promise<Service | null> {
    const [r] = await this.db.select().from(schema.services).where(and(eq(schema.services.id, id), eq(schema.services.handle, handle)));
    if (!r) return null;
    const { createdAt: _, ...s } = r;
    return s;
  }
  async upsertService(s: Service): Promise<void> {
    await this.db.insert(schema.services).values(s).onConflictDoUpdate({ target: schema.services.id, set: { ...s } });
  }
  async createOrder(o: OrderRow): Promise<void> {
    await this.db.insert(schema.orders).values({ ...o, createdAt: new Date(o.createdAt), updatedAt: new Date(o.updatedAt) });
  }
  async getOrder(orderId: string): Promise<OrderRow | null> {
    const [r] = await this.db.select().from(schema.orders).where(eq(schema.orders.orderId, orderId));
    return r ? toOrder(r) : null;
  }
  async listOrders(handle: string, limit = 20): Promise<OrderRow[]> {
    const rows = await this.db.select().from(schema.orders).where(eq(schema.orders.handle, handle)).orderBy(desc(schema.orders.createdAt)).limit(limit);
    return rows.map(toOrder);
  }
  async ordersInStates(states: OrderState[], limit = 100): Promise<OrderRow[]> {
    const rows = await this.db.select().from(schema.orders).where(inArray(schema.orders.state, states)).orderBy(schema.orders.createdAt).limit(limit);
    return rows.map(toOrder);
  }
  async transitionOrder(orderId: string, from: OrderState, to: OrderState): Promise<boolean> {
    const r = await this.db.update(schema.orders).set({ state: to, updatedAt: new Date() })
      .where(and(eq(schema.orders.orderId, orderId), eq(schema.orders.state, from))).returning({ id: schema.orders.orderId });
    return r.length === 1;
  }
}

/** Step checkpoints (docs/swarm.md). `put` keeps the first write: a re-run step can't overwrite. */
export class Artifacts {
  constructor(private readonly db: Db) {}
  async get<T>(orderId: string, step: string): Promise<T | null> {
    const [r] = await this.db.select().from(schema.artifacts).where(and(eq(schema.artifacts.orderId, orderId), eq(schema.artifacts.step, step)));
    return (r?.data as T) ?? null;
  }
  async put(orderId: string, step: string, data: unknown): Promise<boolean> {
    const r = await this.db.insert(schema.artifacts).values({ orderId, step, data }).onConflictDoNothing().returning({ s: schema.artifacts.step });
    return r.length === 1;
  }
  async all(orderId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(schema.artifacts).where(eq(schema.artifacts.orderId, orderId));
    return Object.fromEntries(rows.map((r) => [r.step, r.data]));
  }
  async clear(orderId: string, step: string): Promise<void> {
    await this.db.delete(schema.artifacts).where(and(eq(schema.artifacts.orderId, orderId), eq(schema.artifacts.step, step)));
  }
}

export class Envelopes {
  constructor(private readonly db: Db) {}
  async add(orderId: string, step: string, accountId: string, envelope: unknown): Promise<void> {
    await this.db.insert(schema.envelopes).values({ orderId, step, accountId, envelope });
  }
  async unsettled(limit = 500) {
    return this.db.select().from(schema.envelopes).where(isNull(schema.envelopes.settledBatch)).orderBy(schema.envelopes.id).limit(limit);
  }
  async markSettled(ids: number[], batchId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(schema.envelopes).set({ settledBatch: batchId }).where(inArray(schema.envelopes.id, ids));
  }
  /** Marks envelopes settled into `batchId` and enqueues the chain call in one transaction (no double charge). */
  async settleInto(ids: number[], batchId: string, outboxKind: string, payload: unknown): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(schema.envelopes).set({ settledBatch: batchId }).where(and(inArray(schema.envelopes.id, ids), isNull(schema.envelopes.settledBatch)));
      await tx.insert(schema.outbox).values({ key: `settle:${batchId}`, kind: outboxKind, payload }).onConflictDoNothing();
    });
  }

  async forOrder(orderId: string) {
    return this.db.select().from(schema.envelopes).where(eq(schema.envelopes.orderId, orderId)).orderBy(schema.envelopes.id);
  }
}

export type OutboxHandler = (kind: string, payload: any) => Promise<unknown>;

/**
 * Transactional outbox: `enqueue` is idempotent by key; `drain` sends due items once, retrying failures with
 * backoff. A handler must itself be idempotent for the at-least-once case (crash after send, before commit).
 */
export class Outbox {
  constructor(private readonly db: Db) {}

  async enqueue(key: string, kind: string, payload: unknown): Promise<boolean> {
    const r = await this.db.insert(schema.outbox).values({ key, kind, payload }).onConflictDoNothing().returning({ id: schema.outbox.id });
    return r.length === 1;
  }

  async get(key: string) {
    const [r] = await this.db.select().from(schema.outbox).where(eq(schema.outbox.key, key));
    return r ?? null;
  }

  /** Sends up to `limit` due items. Returns how many were sent. */
  async drain(handler: OutboxHandler, opts: { limit?: number; maxAttempts?: number } = {}): Promise<number> {
    let sent = 0;
    for (let i = 0; i < (opts.limit ?? 20); i++) {
      const item = await this.db.transaction(async (tx) => {
        const [r] = await tx.select().from(schema.outbox)
          .where(and(eq(schema.outbox.state, "pending"), lte(schema.outbox.nextAt, new Date())))
          .orderBy(schema.outbox.id).limit(1).for("update", { skipLocked: true });
        if (!r) return null;
        await tx.update(schema.outbox).set({ state: "sending", attempts: r.attempts + 1, updatedAt: new Date() }).where(eq(schema.outbox.id, r.id));
        return r;
      });
      if (!item) break;
      try {
        const result = await handler(item.kind, item.payload);
        await this.db.update(schema.outbox).set({ state: "done", result: (result ?? null) as never, lastError: null, updatedAt: new Date() }).where(eq(schema.outbox.id, item.id));
        sent++;
      } catch (e) {
        const attempts = item.attempts + 1;
        const dead = attempts >= (opts.maxAttempts ?? 8);
        const backoffMs = Math.min(10 * 60_000, 2_000 * 2 ** (attempts - 1));
        await this.db.update(schema.outbox).set({
          state: dead ? "failed" : "pending", lastError: String((e as Error).message).slice(0, 2000),
          nextAt: new Date(Date.now() + backoffMs), updatedAt: new Date(),
        }).where(eq(schema.outbox.id, item.id));
      }
    }
    return sent;
  }
}

/** Claims an escrow payment for one A2A task. False if the payment id was already used. */
export async function claimA2aPayment(db: Db, row: { paymentId: string; handle: string; taskId: string; amount: string }): Promise<boolean> {
  const r = await db.insert(schema.a2aPayments).values(row).onConflictDoNothing().returning({ id: schema.a2aPayments.paymentId });
  return r.length === 1;
}
