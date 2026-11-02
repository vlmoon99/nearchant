import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./pg.js";
import * as s from "./schema.js";

/** Monthly limits per plan (ported from Boost Content's `plans`: free 12/12, pro 150/300). */
export const PLAN_LIMITS: Record<string, { posts: number; images: number }> = {
  free: { posts: 12, images: 12 },
  pro: { posts: 150, images: 300 },
};

export class QuotaExceeded extends Error {
  constructor(public readonly what: "posts" | "images", public readonly limit: number) {
    super(`quota_exceeded: ${what} limit ${limit} this month`);
  }
}

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);

export type Business = typeof s.businesses.$inferSelect;
export type Profile = typeof s.profiles.$inferSelect;
export type Item = typeof s.items.$inferSelect;
export type Media = typeof s.media.$inferSelect;
export type Opportunity = typeof s.opportunities.$inferSelect;
export type Post = typeof s.posts.$inferSelect;

/** The content store: businesses, what AI learned, items, media, opportunities, posts, signals, events. */
export class ContentStore {
  constructor(private db: Db) {}

  // --- business + profile ---
  async upsertBusiness(b: { handle: string; name: string; kind?: string; description?: string; links?: string[]; language?: string }): Promise<void> {
    const v = { handle: b.handle, name: b.name, kind: b.kind ?? "products", description: b.description ?? "", links: b.links ?? [], language: b.language ?? "en" };
    await this.db.insert(s.businesses).values(v).onConflictDoUpdate({ target: s.businesses.handle, set: { name: v.name, kind: v.kind, description: v.description, links: v.links, language: v.language } });
    await this.db.insert(s.profiles).values({ handle: b.handle }).onConflictDoNothing();
  }
  async getBusiness(handle: string): Promise<Business | null> {
    return (await this.db.select().from(s.businesses).where(eq(s.businesses.handle, handle)))[0] ?? null;
  }
  async completeOnboarding(handle: string): Promise<void> {
    await this.db.update(s.businesses).set({ onboardedAt: new Date() }).where(and(eq(s.businesses.handle, handle), isNull(s.businesses.onboardedAt)));
  }
  async getProfile(handle: string): Promise<Profile | null> {
    return (await this.db.select().from(s.profiles).where(eq(s.profiles.handle, handle)))[0] ?? null;
  }
  async setProfile(handle: string, patch: Partial<Pick<Profile, "status" | "data" | "facts" | "learned" | "error">>): Promise<void> {
    await this.db.insert(s.profiles).values({ handle, ...patch }).onConflictDoUpdate({ target: s.profiles.handle, set: { ...patch, updatedAt: new Date() } });
  }
  /** Appends one fact for the "Getting to know you" screen (shown while the analysis runs). */
  async addFact(handle: string, fact: { title: string; detail: string }): Promise<void> {
    await this.db.update(s.profiles).set({ facts: sql`${s.profiles.facts} || ${JSON.stringify([fact])}::jsonb`, updatedAt: new Date() }).where(eq(s.profiles.handle, handle));
  }

  // --- media + items ---
  async addMedia(m: { handle: string; kind: "photo" | "generated" | "video"; key: string; contentType: string; sha256: string; itemId?: string | null }): Promise<string> {
    const id = `m-${randomUUID()}`;
    await this.db.insert(s.media).values({ id, ...m, itemId: m.itemId ?? null });
    return id;
  }
  async getMedia(id: string): Promise<Media | null> {
    return (await this.db.select().from(s.media).where(eq(s.media.id, id)))[0] ?? null;
  }
  async listMedia(handle: string, kind?: "photo" | "generated"): Promise<Media[]> {
    return this.db.select().from(s.media).where(kind ? and(eq(s.media.handle, handle), eq(s.media.kind, kind)) : eq(s.media.handle, handle)).orderBy(s.media.createdAt);
  }
  async upsertItem(i: { id?: string; handle: string; kind?: string; title: string; description?: string; priceUnits: string; options?: string[]; photoMediaId?: string | null; active?: boolean }): Promise<string> {
    const id = i.id ?? `i-${randomUUID()}`;
    const v = { id, handle: i.handle, kind: i.kind ?? "product", title: i.title, description: i.description ?? "", priceUnits: i.priceUnits, options: i.options ?? [], photoMediaId: i.photoMediaId ?? null, active: i.active ?? true };
    await this.db.insert(s.items).values(v).onConflictDoUpdate({ target: s.items.id, set: { ...v, id: undefined } });
    return id;
  }
  async listItems(handle: string, activeOnly = true): Promise<Item[]> {
    return this.db.select().from(s.items).where(activeOnly ? and(eq(s.items.handle, handle), eq(s.items.active, true)) : eq(s.items.handle, handle)).orderBy(s.items.createdAt);
  }
  async getItem(handle: string, id: string): Promise<Item | null> {
    return (await this.db.select().from(s.items).where(and(eq(s.items.handle, handle), eq(s.items.id, id))))[0] ?? null;
  }

  // --- opportunities ---
  /** Replaces the open (not chosen) opportunities with a fresh set from the AI. */
  async replaceOpportunities(handle: string, list: { kind: string; title: string; why: string; estimateUnits: string; data?: unknown }[]): Promise<string[]> {
    await this.db.delete(s.opportunities).where(and(eq(s.opportunities.handle, handle), eq(s.opportunities.chosen, false)));
    const rows = list.map((o) => ({ id: `op-${randomUUID()}`, handle, kind: o.kind, title: o.title, why: o.why, estimateUnits: o.estimateUnits, data: o.data ?? {} }));
    if (rows.length) await this.db.insert(s.opportunities).values(rows);
    return rows.map((r) => r.id);
  }
  async listOpportunities(handle: string): Promise<Opportunity[]> {
    return this.db.select().from(s.opportunities).where(eq(s.opportunities.handle, handle)).orderBy(s.opportunities.createdAt);
  }
  async chooseOpportunities(handle: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.update(s.opportunities).set({ chosen: true }).where(and(eq(s.opportunities.handle, handle), inArray(s.opportunities.id, ids)));
  }

  // --- quota ---
  /** Reserves posts/images for this month or throws QuotaExceeded (atomic per row). */
  async reserve(handle: string, posts: number, images: number, plan = "free", month = monthOf()): Promise<void> {
    const lim = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free!;
    await this.db.insert(s.usageMonthly).values({ handle, month }).onConflictDoNothing();
    const r = await this.db.update(s.usageMonthly)
      .set({ posts: sql`${s.usageMonthly.posts} + ${posts}`, images: sql`${s.usageMonthly.images} + ${images}` })
      .where(and(eq(s.usageMonthly.handle, handle), eq(s.usageMonthly.month, month), sql`${s.usageMonthly.posts} + ${posts} <= ${lim.posts}`, sql`${s.usageMonthly.images} + ${images} <= ${lim.images}`))
      .returning({ posts: s.usageMonthly.posts });
    if (!r.length) {
      const u = (await this.db.select().from(s.usageMonthly).where(and(eq(s.usageMonthly.handle, handle), eq(s.usageMonthly.month, month))))[0]!;
      throw u.posts + posts > lim.posts ? new QuotaExceeded("posts", lim.posts) : new QuotaExceeded("images", lim.images);
    }
  }
  async refund(handle: string, posts: number, images: number, month = monthOf()): Promise<void> {
    await this.db.update(s.usageMonthly)
      .set({ posts: sql`greatest(${s.usageMonthly.posts} - ${posts}, 0)`, images: sql`greatest(${s.usageMonthly.images} - ${images}, 0)` })
      .where(and(eq(s.usageMonthly.handle, handle), eq(s.usageMonthly.month, month)));
  }
  async usage(handle: string, month = monthOf()): Promise<{ posts: number; images: number }> {
    const u = (await this.db.select().from(s.usageMonthly).where(and(eq(s.usageMonthly.handle, handle), eq(s.usageMonthly.month, month))))[0];
    return { posts: u?.posts ?? 0, images: u?.images ?? 0 };
  }

  // --- posts ---
  /** Queues a batch of post options (one image each), reserving quota first. */
  async createPosts(handle: string, ideas: { idea?: unknown; opportunityId?: string | null; itemId?: string | null; sourceMediaId?: string | null }[], plan = "free"): Promise<{ batchId: string; ids: string[] }> {
    await this.reserve(handle, ideas.length, ideas.length, plan);
    const batchId = `b-${randomUUID()}`;
    const month = monthOf();
    const rows = ideas.map((x) => ({ id: `p-${randomUUID()}`, handle, batchId, quotaMonth: month, idea: x.idea ?? {}, opportunityId: x.opportunityId ?? null, itemId: x.itemId ?? null, sourceMediaId: x.sourceMediaId ?? null }));
    await this.db.insert(s.posts).values(rows);
    return { batchId, ids: rows.map((r) => r.id) };
  }
  /** Where the store is and ships (ADR 0022); an owner's choice is never overwritten by the AI. */
  async setPlace(handle: string, p: { city: string | null; country: string | null; ships: string | null; by: "owner" | "ai" }): Promise<void> {
    const where = p.by === "ai" ? and(eq(s.businesses.handle, handle), sql`coalesce(${s.businesses.placeBy}, '') <> 'owner'`) : eq(s.businesses.handle, handle);
    await this.db.update(s.businesses).set({ city: p.city, country: p.country, ships: p.ships, placeBy: p.by }).where(where);
  }
  async listBusinesses(limit = 1000): Promise<Business[]> {
    return this.db.select().from(s.businesses).orderBy(desc(s.businesses.createdAt)).limit(limit);
  }
  /** Published posts of every store, newest first (backfills). */
  async publishedPosts(limit = 500): Promise<Post[]> {
    return this.db.select().from(s.posts).where(and(eq(s.posts.status, "published"), isNull(s.posts.passedAt))).orderBy(desc(s.posts.publishedAt)).limit(limit);
  }
  async getPost(id: string): Promise<Post | null> {
    return (await this.db.select().from(s.posts).where(eq(s.posts.id, id)))[0] ?? null;
  }
  async updatePost(id: string, patch: Partial<Omit<Post, "id" | "handle" | "batchId" | "createdAt">>): Promise<void> {
    await this.db.update(s.posts).set({ ...patch, updatedAt: new Date() }).where(eq(s.posts.id, id));
  }
  /** A failed post gives its quota back (Boost Content's refund on failure). */
  async failPost(id: string, error: string): Promise<void> {
    const p = await this.getPost(id);
    if (!p || p.status === "failed") return;
    await this.updatePost(id, { status: "failed", error: error.slice(0, 500) });
    await this.refund(p.handle, 1, 1, p.quotaMonth);
  }
  async listPosts(handle: string, o: { status?: string[]; limit?: number } = {}): Promise<Post[]> {
    const where = o.status?.length ? and(eq(s.posts.handle, handle), inArray(s.posts.status, o.status), isNull(s.posts.passedAt)) : and(eq(s.posts.handle, handle), isNull(s.posts.passedAt));
    return this.db.select().from(s.posts).where(where).orderBy(desc(s.posts.createdAt)).limit(o.limit ?? 50);
  }
  /** Keeps some options of a batch and passes the rest; both become learning signals. */
  async choosePosts(handle: string, batchId: string, keep: string[]): Promise<void> {
    const batch = await this.db.select().from(s.posts).where(and(eq(s.posts.handle, handle), eq(s.posts.batchId, batchId)));
    const now = new Date();
    for (const p of batch) {
      const kept = keep.includes(p.id);
      await this.db.update(s.posts).set(kept ? { chosenAt: now, updatedAt: now } : { passedAt: now, updatedAt: now }).where(eq(s.posts.id, p.id));
      await this.addSignal(handle, p.id, kept ? "chose" : "passed", { idea: p.idea });
    }
  }

  // --- operator settings ---
  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return ((await this.db.select().from(s.settings).where(eq(s.settings.key, key)))[0]?.value as T) ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.insert(s.settings).values({ key, value }).onConflictDoUpdate({ target: s.settings.key, set: { value, updatedAt: new Date() } });
  }

  /** Sales (count + summed amount in token units) since `days` ago, from `sale` events. */
  /** The public home page: platform-wide counts and the latest published posts that have a proof on NEAR. */
  async showcase(limit = 3): Promise<{ proofs: number; stores: number; paidOrders: number; posts: { id: string; handle: string; caption: string; publicImage: string | null; proofId: string | null; storeName: string }[] }> {
    const [counts] = (await this.db.execute(sql`select
      (select count(*) from posts where proof is not null)::int as proofs,
      (select count(*) from businesses)::int as stores,
      (select count(*) from orders where state in ('paid', 'in_progress', 'delivered', 'released'))::int as paid_orders`)) as unknown as { proofs: number; stores: number; paid_orders: number }[];
    const rows = await this.db.select({ id: s.posts.id, handle: s.posts.handle, caption: s.posts.caption, idea: s.posts.idea, proof: s.posts.proof, name: s.businesses.name })
      .from(s.posts).innerJoin(s.businesses, eq(s.businesses.handle, s.posts.handle))
      .where(and(eq(s.posts.status, "published"), sql`${s.posts.proof} is not null`, sql`${s.posts.idea}->>'publicImage' is not null`, isNull(s.posts.removedAt), isNull(s.businesses.suspendedAt),
        // Test stores the owner hid from the public pages (setting "showcase_hidden": [handles]).
        sql`${s.posts.handle} not in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'showcase_hidden'), '[]'::jsonb)))`))
      .orderBy(desc(s.posts.publishedAt)).limit(limit);
    return {
      proofs: counts?.proofs ?? 0, stores: counts?.stores ?? 0, paidOrders: counts?.paid_orders ?? 0,
      posts: rows.map((r) => ({ id: r.id, handle: r.handle, caption: r.caption ?? "", publicImage: (r.idea as { publicImage?: string }).publicImage ?? null, proofId: (r.proof as { proofId?: string } | null)?.proofId ?? null, storeName: r.name })),
    };
  }

  async salesSince(handle: string, days: number): Promise<{ count: number; units: bigint }> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.select({ data: s.events.data }).from(s.events).where(and(eq(s.events.handle, handle), eq(s.events.kind, "sale"), gte(s.events.createdAt, since)));
    return { count: rows.length, units: rows.reduce((a, r) => a + BigInt((r.data as { amount?: string }).amount ?? "0"), 0n) };
  }

  // --- signals + events ---
  async addSignal(handle: string, postId: string | null, kind: string, data: unknown = {}): Promise<void> {
    await this.db.insert(s.signals).values({ handle, postId, kind, data });
  }
  async signalsSince(handle: string, afterId = 0): Promise<(typeof s.signals.$inferSelect)[]> {
    return this.db.select().from(s.signals).where(and(eq(s.signals.handle, handle), sql`${s.signals.id} > ${afterId}`)).orderBy(s.signals.id).limit(200);
  }
  async addEvent(e: { handle: string; kind: string; postId?: string | null; itemId?: string | null; orderId?: string | null; source?: string | null; data?: unknown }): Promise<void> {
    await this.db.insert(s.events).values({ handle: e.handle, kind: e.kind, postId: e.postId ?? null, itemId: e.itemId ?? null, orderId: e.orderId ?? null, source: e.source ?? null, data: e.data ?? {} });
  }
  /** Store visits by weekday (0 = Sunday) and hour in a time zone — the "best time to post" heatmap. */
  async visitHours(handle: string, days: number, tz = "America/New_York"): Promise<{ dow: number; hour: number; n: number }[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const local = sql`(${s.events.createdAt} at time zone ${tz})`;
    return this.db.select({ dow: sql<number>`extract(dow from ${local})::int`, hour: sql<number>`extract(hour from ${local})::int`, n: sql<number>`count(*)::int` })
      .from(s.events).where(and(eq(s.events.handle, handle), eq(s.events.kind, "view"), gte(s.events.createdAt, since))).groupBy(sql`1`, sql`2`);
  }
  /** Views per post (visits that came through a post's share link), since `days` ago. */
  /** Explore (nearchant.com/explore): published posts with a public picture from every store, newest first. Hidden
   *  test stores (setting "showcase_hidden") are left out; `before` pages by publish time. */
  async feed(o: { limit?: number; before?: Date } = {}): Promise<{ id: string; handle: string; caption: string; publicImage: string; publicVideo: string | null; proofId: string | null; storeName: string; publishedAt: Date }[]> {
    const rows = await this.db.select({ id: s.posts.id, handle: s.posts.handle, caption: s.posts.caption, idea: s.posts.idea, proof: s.posts.proof, name: s.businesses.name, at: s.posts.publishedAt })
      .from(s.posts).innerJoin(s.businesses, eq(s.businesses.handle, s.posts.handle))
      .where(and(eq(s.posts.status, "published"), sql`${s.posts.idea}->>'publicImage' is not null`, sql`${s.posts.publishedAt} is not null`, isNull(s.posts.removedAt), isNull(s.businesses.suspendedAt),
        o.before ? lt(s.posts.publishedAt, o.before) : undefined,
        sql`${s.posts.handle} not in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'showcase_hidden'), '[]'::jsonb)))`))
      .orderBy(desc(s.posts.publishedAt)).limit(Math.min(o.limit ?? 24, 60));
    return rows.map((r) => {
      const idea = r.idea as { publicImage: string; publicVideo?: string };
      return { id: r.id, handle: r.handle, caption: r.caption ?? "", publicImage: idea.publicImage, publicVideo: idea.publicVideo ?? null, proofId: (r.proof as { proofId?: string } | null)?.proofId ?? null, storeName: r.name, publishedAt: r.at! };
    });
  }
  async postViews(handle: string, days: number): Promise<Map<string, number>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.select({ id: s.events.postId, n: sql<number>`count(*)::int` }).from(s.events)
      .where(and(eq(s.events.handle, handle), eq(s.events.kind, "view"), gte(s.events.createdAt, since), sql`${s.events.postId} is not null`)).groupBy(s.events.postId);
    return new Map(rows.map((r) => [r.id!, r.n]));
  }
  /** Store views by source (telegram, instagram, direct, …) since `days` ago, most first. */
  async viewSources(handle: string, days: number): Promise<[string, number][]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.select({ src: sql<string>`coalesce(${s.events.source}, 'direct')`, n: sql<number>`count(*)::int` }).from(s.events)
      .where(and(eq(s.events.handle, handle), eq(s.events.kind, "view"), gte(s.events.createdAt, since))).groupBy(sql`1`).orderBy(sql`2 desc`).limit(6);
    return rows.map((r) => [r.src, r.n]);
  }

  /** Counts per day and kind since `days` ago (UTC days), for the analytics charts. */
  async eventCounts(handle: string, days: number): Promise<{ day: string; kind: string; n: number }[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.select({ day: sql<string>`to_char(${s.events.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, kind: s.events.kind, n: sql<number>`count(*)::int` })
      .from(s.events).where(and(eq(s.events.handle, handle), gte(s.events.createdAt, since)))
      .groupBy(sql`1`, s.events.kind).orderBy(sql`1`);
    return rows;
  }
}
