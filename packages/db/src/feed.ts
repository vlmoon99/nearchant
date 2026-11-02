// Shop feed, buyers, likes, reports, moderation records (ADR 0022).
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./pg.js";
import * as s from "./schema.js";

export type Buyer = typeof s.buyers.$inferSelect;
export type Report = typeof s.reports.$inferSelect;
export type Violator = typeof s.violators.$inferSelect;
export const REPORT_REASONS = ["scam", "illegal", "sexual", "violence", "hate", "counterfeit", "spam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const SHIPS = ["local", "country", "world"] as const;
/** A store sells a searched good when its best item/post/profile is at least this close in meaning. */
export const STORE_MATCH_AT = 0.5;
export interface StoreMatch {
  handle: string; name: string; city: string | null; country: string | null; ships: string | null;
  goods: { name: string; match: boolean; sim: number }[]; matched: number; score: number; image: string | null; followers: number;
}

export interface FeedQuery {
  /** Query embedding (null → no semantic part). */
  vector?: number[] | null;
  /** Words to match in text (goods + synonyms). */
  terms?: string[];
  country?: string | null;
  city?: string | null;
  /** The signed-in buyer: their likes steer "For you" and their own likes are marked. */
  buyerId?: string | null;
  /** Only the posts this buyer liked (the "Liked" page). */
  onlyLiked?: boolean;
  /** Only posts of stores this buyer follows (the "Following" feed). */
  onlyFollowing?: boolean;
  /** The visitor's country (from the CDN): a soft boost for stores there or shipping worldwide, never a filter. */
  preferCountry?: string | null;
  /** Leave these posts out (e.g. the post a "More like this" list belongs to). */
  exclude?: string[];
  limit?: number;
  offset?: number;
}
export interface FeedPost {
  id: string; handle: string; caption: string; publicImage: string; publicVideo: string | null; proofId: string | null; itemId: string | null;
  storeName: string; city: string | null; country: string | null; ships: string | null; likes: number; liked: boolean; score: number; publishedAt: Date;
  /** Why it is in the results, in a few words ("In New York", "Ships worldwide"), when a place was searched. */
  why: string | null;
}

const vec = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
/** Text of a post for search: caption, hashtags, item title, store name. */
export const postSearchText = (p: { caption: string | null; hashtags: unknown }, store: string, item?: string | null) =>
  [p.caption ?? "", ((p.hashtags as string[]) ?? []).map((h) => `#${h}`).join(" "), item ?? "", store].filter(Boolean).join("\n").slice(0, 4000);

export class FeedStore {
  constructor(private readonly db: Db) {}

  // ── buyers ──
  async buyerByEmail(email: string): Promise<Buyer> {
    const found = (await this.db.select().from(s.buyers).where(eq(s.buyers.email, email)))[0];
    if (found) return found;
    const [b] = await this.db.insert(s.buyers).values({ id: `b-${randomUUID()}`, email }).onConflictDoNothing().returning();
    return b ?? (await this.db.select().from(s.buyers).where(eq(s.buyers.email, email)))[0]!;
  }
  async buyerByWallet(wallet: string): Promise<Buyer> {
    const found = (await this.db.select().from(s.buyers).where(eq(s.buyers.wallet, wallet)))[0];
    if (found) return found;
    const [b] = await this.db.insert(s.buyers).values({ id: `b-${randomUUID()}`, wallet }).onConflictDoNothing().returning();
    return b ?? (await this.db.select().from(s.buyers).where(eq(s.buyers.wallet, wallet)))[0]!;
  }
  async getBuyer(id: string): Promise<Buyer | null> {
    return (await this.db.select().from(s.buyers).where(eq(s.buyers.id, id)))[0] ?? null;
  }
  async touchBuyer(id: string): Promise<void> {
    await this.db.update(s.buyers).set({ lastSeenAt: new Date() }).where(eq(s.buyers.id, id));
  }
  async banBuyer(id: string, reason: string | null): Promise<void> {
    await this.db.update(s.buyers).set({ status: reason ? "banned" : "active", bannedReason: reason }).where(eq(s.buyers.id, id));
  }

  /** IPs per account, for the violators list only (kept 180 days). */
  async logIp(kind: "store" | "buyer", id: string, ip: string | null | undefined): Promise<void> {
    if (!ip || ip === "unknown") return;
    await this.db.insert(s.ipLog).values({ subjectKind: kind, subjectId: id, ip: ip.slice(0, 64) })
      .onConflictDoUpdate({ target: [s.ipLog.subjectKind, s.ipLog.subjectId, s.ipLog.ip], set: { n: sql`${s.ipLog.n} + 1`, lastAt: new Date() } });
  }
  async ipsOf(kind: "store" | "buyer", id: string): Promise<string[]> {
    return (await this.db.select({ ip: s.ipLog.ip }).from(s.ipLog).where(and(eq(s.ipLog.subjectKind, kind), eq(s.ipLog.subjectId, id))).orderBy(desc(s.ipLog.lastAt)).limit(50)).map((r) => r.ip);
  }
  async pruneIps(days = 180): Promise<void> {
    await this.db.delete(s.ipLog).where(sql`${s.ipLog.lastAt} < now() - make_interval(days => ${days})`);
  }

  // ── likes ──
  async like(buyerId: string, postId: string, on: boolean): Promise<number> {
    if (on) await this.db.insert(s.likes).values({ buyerId, postId }).onConflictDoNothing();
    else await this.db.delete(s.likes).where(and(eq(s.likes.buyerId, buyerId), eq(s.likes.postId, postId)));
    return (await this.likeCounts([postId])).get(postId) ?? 0;
  }
  async likeCounts(postIds: string[]): Promise<Map<string, number>> {
    if (!postIds.length) return new Map();
    const rows = await this.db.select({ id: s.likes.postId, n: sql<number>`count(*)::int` }).from(s.likes).where(inArray(s.likes.postId, postIds)).groupBy(s.likes.postId);
    return new Map(rows.map((r) => [r.id, r.n]));
  }
  async likedBy(buyerId: string, postIds: string[]): Promise<Set<string>> {
    if (!postIds.length) return new Set();
    return new Set((await this.db.select({ id: s.likes.postId }).from(s.likes).where(and(eq(s.likes.buyerId, buyerId), inArray(s.likes.postId, postIds)))).map((r) => r.id));
  }

  // ── follows ──
  async follow(buyerId: string, handle: string, on: boolean): Promise<number> {
    if (on) await this.db.insert(s.follows).values({ buyerId, handle }).onConflictDoNothing();
    else await this.db.delete(s.follows).where(and(eq(s.follows.buyerId, buyerId), eq(s.follows.handle, handle)));
    return this.followers(handle);
  }
  async followers(handle: string): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.follows).where(eq(s.follows.handle, handle));
    return r?.n ?? 0;
  }
  async follows(buyerId: string, handle: string): Promise<boolean> {
    return !!(await this.db.select({ h: s.follows.handle }).from(s.follows).where(and(eq(s.follows.buyerId, buyerId), eq(s.follows.handle, handle))))[0];
  }

  // ── search vectors ──
  async vectorHash(kind: string, refId: string): Promise<string | null> {
    return (await this.db.select({ h: s.contentVectors.textHash }).from(s.contentVectors).where(and(eq(s.contentVectors.kind, kind), eq(s.contentVectors.refId, refId))))[0]?.h ?? null;
  }
  async putVector(kind: "post" | "item" | "store", refId: string, handle: string, textHash: string, embedding: number[]): Promise<void> {
    await this.db.insert(s.contentVectors).values({ kind, refId, handle, textHash, embedding })
      .onConflictDoUpdate({ target: [s.contentVectors.kind, s.contentVectors.refId], set: { textHash, embedding, updatedAt: new Date() } });
  }

  /**
   * The feed: published, not removed posts of active stores with a public picture. With a query: semantic match
   * (best of post, its item and its store) + full-text match, filtered by region. Without: "For you" (similar to the
   * buyer's likes) + likes + freshness.
   */
  async feed(q: FeedQuery): Promise<FeedPost[]> {
    const qv = q.vector?.length ? sql`${vec(q.vector)}::vector` : null;
    const terms = (q.terms ?? []).map((t) => t.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim()).filter(Boolean).slice(0, 24);
    const tsq = terms.length ? sql`to_tsquery('simple', ${terms.map((t) => t.split(/\s+/).map((w) => `${w}:*`).join(" & ")).map((x) => `(${x})`).join(" | ")})` : null;
    const country = q.country?.toUpperCase().slice(0, 2) || null, city = q.city?.trim().toLowerCase() || null;
    const buyerVec = q.buyerId ? sql`(select avg(cv.embedding) from likes l join content_vectors cv on cv.kind = 'post' and cv.ref_id = l.post_id where l.buyer_id = ${q.buyerId})` : sql`null::vector`;
    const doc = sql`to_tsvector('simple', coalesce(p.caption,'') || ' ' || coalesce(p.hashtags::text,'') || ' ' || b.name || ' ' || b.description || ' ' || coalesce(i.title,''))`;
    const semantic = qv ? sql`greatest(coalesce(1 - (pv.embedding <=> ${qv}), 0), coalesce(1 - (iv.embedding <=> ${qv}), 0), coalesce((1 - (sv.embedding <=> ${qv})) * 0.9, 0))` : sql`0`;
    const text = tsq ? sql`ts_rank(${doc}, ${tsq})` : sql`0`;
    const region = country
      ? sql`(b.ships = 'world' or b.country is null or (b.country = ${country} and (b.ships = 'country' or b.ships is null or ${city}::text is null or lower(b.city) = ${city})))`
      : sql`true`;
    const rows = (await this.db.execute(sql`
      with me as (select ${buyerVec} as v)
      select p.id, p.handle, coalesce(p.caption,'') as caption, p.idea->>'publicImage' as public_image, p.idea->>'publicVideo' as public_video,
        p.proof->>'proofId' as proof_id, p.item_id, b.name as store_name, b.city, b.country, b.ships, p.published_at,
        (select count(*)::int from likes l where l.post_id = p.id) as likes,
        ${q.buyerId ? sql`exists(select 1 from likes l where l.post_id = p.id and l.buyer_id = ${q.buyerId})` : sql`false`} as liked,
        ${semantic} as sem, ${text} as txt,
        coalesce(1 - (pv.embedding <=> (select v from me)), 0) as fy,
        ${q.buyerId ? sql`exists(select 1 from follows f where f.handle = p.handle and f.buyer_id = ${q.buyerId})` : sql`false`} as followed
      from posts p
      join businesses b on b.handle = p.handle
      left join items i on i.id = p.item_id
      left join content_vectors pv on pv.kind = 'post' and pv.ref_id = p.id
      left join content_vectors iv on iv.kind = 'item' and iv.ref_id = p.item_id
      left join content_vectors sv on sv.kind = 'store' and sv.ref_id = p.handle
      where p.status = 'published' and p.removed_at is null and p.passed_at is null and b.suspended_at is null
        and p.idea->>'publicImage' is not null and ${region}
        and p.handle not in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'showcase_hidden'), '[]'::jsonb)))
        ${q.onlyLiked && q.buyerId ? sql`and exists(select 1 from likes l where l.post_id = p.id and l.buyer_id = ${q.buyerId})` : sql``}
        ${q.onlyFollowing && q.buyerId ? sql`and exists(select 1 from follows f where f.handle = p.handle and f.buyer_id = ${q.buyerId})` : sql``}
        ${q.exclude?.length ? sql`and p.id not in (${sql.join(q.exclude.map((x) => sql`${x}`), sql`, `)})` : sql``}
    `)) as unknown as Record<string, unknown>[];
    const now = Date.now();
    const scored = rows.map((r) => {
      const sem = Number(r.sem), txt = Number(r.txt), fy = Number(r.fy), likes = Number(r.likes);
      const ageDays = (now - new Date(r.published_at as string).getTime()) / 86_400_000;
      const fresh = Math.exp(-ageDays / 14), pop = Math.log1p(likes) / 4;
      // A named place: the store's own city ranks first; stores that never said where they are come last.
      const regionBoost = (city && String(r.city ?? "").toLowerCase() === city ? 0.08 : 0) - (country && !r.country ? 0.2 : 0);
      const followBoost = r.followed ? 0.25 : 0;
      const pc = q.preferCountry?.toUpperCase();
      const nearBoost = pc && !country && (r.country === pc || r.ships === "world") ? 0.12 : 0;
      const relevant = q.onlyLiked || q.onlyFollowing || (!qv && !tsq) ? true : sem >= 0.45 || txt > 0;
      const why = !country ? null : city && String(r.city ?? "").toLowerCase() === city ? `In ${r.city}` : r.ships === "world" ? "Ships worldwide"
        : r.country === country && r.ships === "country" ? `Ships across ${country}` : r.country === country ? `In ${r.city ?? country}` : !r.country ? "Location not set" : null;
      const score = qv || tsq ? sem * 1 + Math.min(txt, 0.5) * 0.8 + regionBoost + nearBoost / 2 + pop * 0.15 + fresh * 0.05 : (q.buyerId ? fy * 0.6 : 0) + pop * 0.3 + fresh * 0.4 + regionBoost + followBoost + nearBoost;
      return { relevant, post: { id: String(r.id), handle: String(r.handle), caption: String(r.caption), publicImage: String(r.public_image), publicVideo: (r.public_video as string) ?? null,
        proofId: (r.proof_id as string) ?? null, itemId: (r.item_id as string) ?? null, storeName: String(r.store_name), city: (r.city as string) ?? null, country: (r.country as string) ?? null,
        ships: (r.ships as string) ?? null, likes, liked: !!r.liked, score: Math.round(score * 1000) / 1000, publishedAt: new Date(r.published_at as string), why } satisfies FeedPost };
    }).filter((x) => x.relevant).map((x) => x.post);
    scored.sort((a, b) => b.score - a.score || b.publishedAt.getTime() - a.publishedAt.getTime());
    // At most 3 posts per store in a row of results, so one big store can't fill the feed.
    const perStore = new Map<string, number>(), out: FeedPost[] = [], later: FeedPost[] = [];
    for (const p of scored) { const n = perStore.get(p.handle) ?? 0; (n < 3 ? out : later).push(p); perStore.set(p.handle, n + 1); }
    return [...out, ...later].slice(q.offset ?? 0, (q.offset ?? 0) + Math.min(q.limit ?? 24, 60));
  }

  /**
   * "Stores that sell 1, 2, 3, 4": for each searched good, the best match (meaning) among a store's items, posts and
   * profile; stores that sell more of the list come first. Region rules as in the feed.
   */
  async storesFor(goods: { name: string; vector: number[] }[], o: { city?: string | null; country?: string | null; limit?: number } = {}): Promise<StoreMatch[]> {
    if (!goods.length) return [];
    const country = o.country?.toUpperCase().slice(0, 2) || null, city = o.city?.trim().toLowerCase() || null;
    const g = sql.join(goods.slice(0, 8).map((x, i) => sql`(${i}::int, ${vec(x.vector)}::vector)`), sql`, `);
    const region = country
      ? sql`(b.ships = 'world' or b.country is null or (b.country = ${country} and (b.ships = 'country' or b.ships is null or ${city}::text is null or lower(b.city) = ${city})))`
      : sql`true`;
    const rows = (await this.db.execute(sql`
      with g(i, v) as (values ${g})
      select b.handle, b.name, b.city, b.country, b.ships, g.i, max(1 - (cv.embedding <=> g.v)) as sim
      from businesses b join content_vectors cv on cv.handle = b.handle cross join g
      where b.suspended_at is null and ${region}
        and (cv.kind <> 'post' or exists (select 1 from posts p where p.id = cv.ref_id and p.status = 'published' and p.removed_at is null))
        and (cv.kind <> 'item' or exists (select 1 from items it where it.id = cv.ref_id and it.active))
        and b.handle not in (select jsonb_array_elements_text(coalesce((select value from settings where key = 'showcase_hidden'), '[]'::jsonb)))
        and exists (select 1 from posts p where p.handle = b.handle and p.status = 'published' and p.removed_at is null)
      group by b.handle, b.name, b.city, b.country, b.ships, g.i
    `)) as unknown as { handle: string; name: string; city: string | null; country: string | null; ships: string | null; i: number; sim: number }[];
    const by = new Map<string, StoreMatch>();
    for (const r of rows) {
      const m = by.get(r.handle) ?? { handle: r.handle, name: r.name, city: r.city, country: r.country, ships: r.ships, goods: goods.map((x) => ({ name: x.name, match: false, sim: 0 })), matched: 0, score: 0, image: null, followers: 0 };
      const sim = Number(r.sim);
      m.goods[Number(r.i)] = { name: goods[Number(r.i)]!.name, match: sim >= STORE_MATCH_AT, sim: Math.round(sim * 1000) / 1000 };
      by.set(r.handle, m);
    }
    const list = [...by.values()].map((m) => ({ ...m, matched: m.goods.filter((x) => x.match).length, score: m.goods.reduce((a, x) => a + x.sim, 0) / m.goods.length }))
      .filter((m) => m.matched > 0)
      .sort((a, b) => b.matched - a.matched || (city && String(b.city ?? "").toLowerCase() === city ? 1 : 0) - (city && String(a.city ?? "").toLowerCase() === city ? 1 : 0) || b.score - a.score)
      .slice(0, o.limit ?? 6);
    for (const m of list) {
      const [img] = (await this.db.execute(sql`select p.idea->>'publicImage' as img from posts p where p.handle = ${m.handle} and p.status = 'published' and p.removed_at is null and p.idea->>'publicImage' is not null order by p.published_at desc limit 1`)) as unknown as { img: string | null }[];
      m.image = img?.img ?? null;
      m.followers = await this.followers(m.handle);
    }
    return list;
  }

  /** "More like this": posts from any store closest in meaning to this one. */
  async similar(postId: string, limit = 8): Promise<FeedPost[]> {
    const row = (await this.db.select({ e: s.contentVectors.embedding }).from(s.contentVectors).where(and(eq(s.contentVectors.kind, "post"), eq(s.contentVectors.refId, postId))))[0];
    if (!row) return [];
    return (await this.feed({ vector: row.e as number[], exclude: [postId], limit: limit * 2 })).slice(0, limit);
  }

  // ── search demand (anonymous) ──
  async logSearch(e: { q: string; goods: string[]; city: string | null; country: string | null; results: number; handles: string[] }): Promise<void> {
    await this.db.insert(s.searchLog).values({ q: e.q.slice(0, 200), goods: e.goods.slice(0, 8), city: e.city, country: e.country, results: e.results, handles: [...new Set(e.handles)].slice(0, 30) });
  }
  /** What shoppers looked for in the last `days` (optionally in one country), most searched first, with how many found nothing. */
  async demand(o: { days: number; country?: string | null; limit?: number }): Promise<{ goods: string; searches: number; empty: number }[]> {
    const rows = (await this.db.execute(sql`select g as goods, count(*)::int as searches, count(*) filter (where results = 0)::int as empty
      from search_log, jsonb_array_elements_text(goods) g
      where created_at > now() - make_interval(days => ${o.days}) ${o.country ? sql`and (country = ${o.country} or country is null)` : sql``}
      group by g order by 2 desc, 1 limit ${o.limit ?? 8}`)) as unknown as { goods: string; searches: number; empty: number }[];
    return rows.map((r) => ({ goods: r.goods, searches: Number(r.searches), empty: Number(r.empty) }));
  }
  /** Searches in the last `days` that showed this store's posts, and their top goods. */
  async searchesFor(handle: string, days: number): Promise<{ count: number; goods: string[] }> {
    const rows = (await this.db.execute(sql`select goods from search_log where created_at > now() - make_interval(days => ${days}) and handles ? ${handle}`)) as unknown as { goods: string[] }[];
    const n = new Map<string, number>();
    for (const r of rows) for (const g of r.goods ?? []) n.set(g, (n.get(g) ?? 0) + 1);
    return { count: rows.length, goods: [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g) };
  }

  // ── reports ──
  async addReport(r: { targetKind: "post" | "store"; postId?: string | null; handle: string; reporterBuyerId?: string | null; reporterIp?: string | null; reason: ReportReason; note?: string }): Promise<number> {
    const [row] = await this.db.insert(s.reports).values({ targetKind: r.targetKind, postId: r.postId ?? null, handle: r.handle, reporterBuyerId: r.reporterBuyerId ?? null, reporterIp: r.reporterIp ?? null, reason: r.reason, note: (r.note ?? "").slice(0, 1000) }).returning({ id: s.reports.id });
    return row!.id;
  }
  async getReport(id: number): Promise<Report | null> {
    return (await this.db.select().from(s.reports).where(eq(s.reports.id, id)))[0] ?? null;
  }
  async listReports(o: { status?: string[]; limit?: number } = {}): Promise<Report[]> {
    return this.db.select().from(s.reports).where(o.status?.length ? inArray(s.reports.status, o.status) : undefined).orderBy(desc(s.reports.createdAt)).limit(o.limit ?? 100);
  }
  async decideReport(id: number, status: "auto_removed" | "auto_kept" | "removed" | "kept" | "open", by: string, ai?: unknown): Promise<void> {
    await this.db.update(s.reports).set({ status, decidedBy: by, decidedAt: new Date(), ...(ai !== undefined ? { ai } : {}) }).where(eq(s.reports.id, id));
  }
  /** Reports from one IP or buyer in the last hour (abuse guard). */
  async recentReports(by: { ip?: string | null; buyerId?: string | null }): Promise<number> {
    const who = by.buyerId ? eq(s.reports.reporterBuyerId, by.buyerId) : by.ip ? eq(s.reports.reporterIp, by.ip) : null;
    if (!who) return 0;
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.reports).where(and(who, sql`${s.reports.createdAt} > now() - interval '1 hour'`));
    return r?.n ?? 0;
  }

  // ── moderation ──
  /** Removes a post and records the violation against its store; returns the store's active violation count. */
  async removePost(postId: string, v: { category: string; confidence: number; summary: string; by: string; reportId?: number | null; identity: { accounts: string[]; emails: string[] } }): Promise<{ handle: string; count: number } | null> {
    const p = (await this.db.select().from(s.posts).where(eq(s.posts.id, postId)))[0];
    if (!p) return null;
    // One post counts once: removing it again (more reports, a retried job) adds no violation.
    const [claimed] = await this.db.update(s.posts).set({ removedAt: new Date(), removedReason: `${v.category}: ${v.summary}`.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(s.posts.id, postId), isNull(s.posts.removedAt))).returning({ id: s.posts.id });
    if (!claimed) return { handle: p.handle, count: await this.activeViolations("store", p.handle) };
    const count = await this.recordViolation("store", p.handle, v.identity, { postId, reportId: v.reportId ?? null, category: v.category, confidence: v.confidence, summary: v.summary, by: v.by });
    return { handle: p.handle, count };
  }
  async restorePost(postId: string, by: string): Promise<void> {
    await this.db.update(s.posts).set({ removedAt: null, removedReason: null, updatedAt: new Date() }).where(eq(s.posts.id, postId));
    const undone = await this.db.update(s.violations).set({ undoneAt: new Date(), undoneBy: by }).where(and(eq(s.violations.postId, postId), isNull(s.violations.undoneAt))).returning({ v: s.violations.violatorId });
    for (const id of new Set(undone.map((u) => u.v))) {
      const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.violations).where(and(eq(s.violations.violatorId, id), isNull(s.violations.undoneAt)));
      await this.db.update(s.violators).set({ count: c?.n ?? 0 }).where(eq(s.violators.id, id));
    }
  }
  async activeViolations(kind: "store" | "buyer", id: string): Promise<number> {
    const v = (await this.db.select().from(s.violators).where(and(eq(s.violators.subjectKind, kind), eq(s.violators.subjectId, id))))[0];
    if (!v) return 0;
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.violations).where(and(eq(s.violations.violatorId, v.id), isNull(s.violations.undoneAt)));
    return c?.n ?? 0;
  }
  /** Has this buyer reported this post or store already (one report each)? */
  async reportedBefore(buyerId: string, target: { postId?: string | null; handle: string }): Promise<boolean> {
    const where = target.postId ? and(eq(s.reports.reporterBuyerId, buyerId), eq(s.reports.postId, target.postId)) : and(eq(s.reports.reporterBuyerId, buyerId), eq(s.reports.handle, target.handle), eq(s.reports.targetKind, "store"));
    return !!(await this.db.select({ id: s.reports.id }).from(s.reports).where(where).limit(1))[0];
  }
  async recordViolation(kind: "store" | "buyer", id: string, identity: { accounts: string[]; emails: string[] }, v: { postId?: string | null; reportId?: number | null; category: string; confidence: number; summary: string; by: string }): Promise<number> {
    const ips = await this.ipsOf(kind, id);
    const merge = (col: unknown, add: string[]) => [...new Set([...((col as string[]) ?? []), ...add.filter(Boolean)])].slice(0, 100);
    const old = (await this.db.select().from(s.violators).where(and(eq(s.violators.subjectKind, kind), eq(s.violators.subjectId, id))))[0];
    let violatorId: number;
    if (old) {
      await this.db.update(s.violators).set({ accounts: merge(old.accounts, identity.accounts), emails: merge(old.emails, identity.emails), ips: merge(old.ips, ips), lastAt: new Date() }).where(eq(s.violators.id, old.id));
      violatorId = old.id;
    } else {
      const [row] = await this.db.insert(s.violators).values({ subjectKind: kind, subjectId: id, accounts: identity.accounts, emails: identity.emails, ips }).returning({ id: s.violators.id });
      violatorId = row!.id;
    }
    await this.db.insert(s.violations).values({ violatorId, postId: v.postId ?? null, reportId: v.reportId ?? null, category: v.category, confidence: Math.round(v.confidence * 100), summary: v.summary.slice(0, 500), by: v.by });
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(s.violations).where(and(eq(s.violations.violatorId, violatorId), isNull(s.violations.undoneAt)));
    await this.db.update(s.violators).set({ count: c?.n ?? 0 }).where(eq(s.violators.id, violatorId));
    return c?.n ?? 0;
  }
  async listViolators(limit = 200): Promise<(Violator & { violations: { category: string; summary: string; by: string; postId: string | null; undone: boolean; at: Date }[] })[]> {
    const vs = await this.db.select().from(s.violators).orderBy(desc(s.violators.lastAt)).limit(limit);
    if (!vs.length) return [];
    const rows = await this.db.select().from(s.violations).where(inArray(s.violations.violatorId, vs.map((v) => v.id))).orderBy(desc(s.violations.createdAt));
    return vs.map((v) => ({ ...v, violations: rows.filter((r) => r.violatorId === v.id).map((r) => ({ category: r.category, summary: r.summary, by: r.by, postId: r.postId, undone: !!r.undoneAt, at: r.createdAt })) }));
  }
  async suspendStore(handle: string, reason: string | null): Promise<void> {
    await this.db.update(s.businesses).set({ suspendedAt: reason ? new Date() : null, suspendedReason: reason }).where(eq(s.businesses.handle, handle));
  }
  async removedPosts(limit = 100): Promise<{ id: string; handle: string; caption: string; reason: string; at: Date; image: string | null; moderation: unknown }[]> {
    const rows = await this.db.select().from(s.posts).where(sql`${s.posts.removedAt} is not null`).orderBy(desc(s.posts.removedAt)).limit(limit);
    return rows.map((p) => ({ id: p.id, handle: p.handle, caption: p.caption ?? "", reason: p.removedReason ?? "", at: p.removedAt!, image: (p.idea as { publicImage?: string }).publicImage ?? null, moderation: p.moderation }));
  }

  // ── admin log ──
  async log(actor: string, action: string, target: string, data: unknown = {}): Promise<void> {
    await this.db.insert(s.adminLog).values({ actor: actor.slice(0, 60), action, target, data });
  }
  async listLog(limit = 200): Promise<(typeof s.adminLog.$inferSelect)[]> {
    return this.db.select().from(s.adminLog).orderBy(desc(s.adminLog.createdAt)).limit(limit);
  }
}
