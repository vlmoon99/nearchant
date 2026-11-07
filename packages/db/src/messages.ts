// Messages between a store and the buyer of one order (off-chain: instant and free; payments stay on chain).
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./pg.js";
import * as s from "./schema.js";

export type MessageAuthor = "seller" | "buyer";
export interface OrderMessage { id: number; orderId: string; author: MessageAuthor; text: string; at: string; read: boolean }

export class Messages {
  constructor(private db: Db) {}

  async add(orderId: string, handle: string, author: MessageAuthor, text: string): Promise<OrderMessage> {
    const [r] = await this.db.insert(s.orderMessages).values({ orderId, handle, author, text }).returning();
    return { id: r!.id, orderId, author, text, at: r!.createdAt.toISOString(), read: false };
  }

  /** The thread, oldest first. */
  async list(orderId: string, limit = 200): Promise<OrderMessage[]> {
    const rows = await this.db.select().from(s.orderMessages).where(eq(s.orderMessages.orderId, orderId)).orderBy(desc(s.orderMessages.id)).limit(limit);
    return rows.reverse().map((r) => ({ id: r.id, orderId: r.orderId, author: r.author as MessageAuthor, text: r.text, at: r.createdAt.toISOString(), read: !!r.readAt }));
  }

  /** `reader` opened the thread: the other side's messages are read. */
  async markRead(orderId: string, reader: MessageAuthor): Promise<void> {
    await this.db.update(s.orderMessages).set({ readAt: new Date() })
      .where(and(eq(s.orderMessages.orderId, orderId), ne(s.orderMessages.author, reader), isNull(s.orderMessages.readAt)));
  }

  /** Unread buyer messages per order of one store (for the Orders list and the nav badge). */
  async unreadForSeller(handle: string): Promise<Map<string, number>> {
    const rows = await this.db.select({ orderId: s.orderMessages.orderId, n: sql<number>`count(*)::int` }).from(s.orderMessages)
      .where(and(eq(s.orderMessages.handle, handle), eq(s.orderMessages.author, "buyer"), isNull(s.orderMessages.readAt))).groupBy(s.orderMessages.orderId);
    return new Map(rows.map((r) => [r.orderId, r.n]));
  }

  /** The latest message of each order (for the Orders list). */
  async latest(orderIds: string[]): Promise<Map<string, OrderMessage>> {
    if (!orderIds.length) return new Map();
    const rows = await this.db.selectDistinctOn([s.orderMessages.orderId]).from(s.orderMessages)
      .where(inArray(s.orderMessages.orderId, orderIds)).orderBy(s.orderMessages.orderId, desc(s.orderMessages.id));
    return new Map(rows.map((r) => [r.orderId, { id: r.id, orderId: r.orderId, author: r.author as MessageAuthor, text: r.text, at: r.createdAt.toISOString(), read: !!r.readAt }]));
  }

  /** Messages one side sent in the last `ms` (a simple flood limit). */
  async recentCount(orderId: string, author: MessageAuthor, ms: number): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.orderMessages)
      .where(and(eq(s.orderMessages.orderId, orderId), eq(s.orderMessages.author, author), sql`${s.orderMessages.createdAt} > now() - make_interval(secs => ${ms / 1000})`));
    return r?.n ?? 0;
  }
}
