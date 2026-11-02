// Worker tasks for the marketplace (ADR 0022): the moderator agent, search vectors, store places, a backfill.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Task } from "graphile-worker";
import { postSearchText, type ContentStore, type Envelopes, type FeedStore } from "@nearchant/db";
import { findPlace, makeAsker, moderatePost, shouldRemove, type AgentEnv, type ModelRouter, type ModVerdict } from "@nearchant/swarm";
import { photoDataUrl } from "./content-tasks.js";

export interface MarketTaskDeps {
  content: ContentStore;
  feed: FeedStore;
  envelopes: Envelopes;
  router: ModelRouter;
  env: AgentEnv;
  mediaDir: string;
  accountOf: (handle: string) => string;
  log: (m: string) => void;
  /** Tell a store owner (email) that a post was removed. */
  notify?: (handle: string, subject: string, lines: string[]) => Promise<void>;
}

/** Store-profile violations that pause a store (the others are left to a person). */
const PROFILE_CATEGORIES: string[] = ["illegal", "sexual", "violence", "hate", "scam"];
/** Removals after which a store is suspended. */
export const SUSPEND_AFTER = 3;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function makeMarketTasks(d: MarketTaskDeps) {
  const ask = (handle: string, step: string) => makeAsker(d.env, d.router, async (e) => { await d.envelopes.add(`market:${handle}:${step}`, step, d.accountOf(handle), e); });

  /** Judges a post; removes it (and maybe suspends the store) when the moderator is sure. Returns the verdict. */
  async function moderate(postId: string, reportId?: number | null): Promise<ModVerdict | null> {
    const p = await d.content.getPost(postId);
    if (!p) return null;
    const b = await d.content.getBusiness(p.handle);
    const report = reportId ? await d.feed.getReport(reportId) : null;
    const key = (p.idea as { publicImage?: string }).publicImage ?? (p.imageMediaId ? (await d.content.getMedia(p.imageMediaId))?.key : null);
    const image = key ? await photoDataUrl(join(d.mediaDir, key)).catch(() => null) : null;
    const v = await moderatePost(ask(p.handle, "moderate"), {
      caption: p.caption ?? "", hashtags: (p.hashtags as string[]) ?? [], store: b?.name ?? p.handle, storeDescription: b?.description ?? "", image,
      report: report ? { reason: report.reason, note: report.note } : null,
    });
    await d.content.updatePost(postId, { moderation: { ...v, ...(reportId ? { reportId } : {}) } });
    if (shouldRemove(v)) {
      const identity = { accounts: [d.accountOf(p.handle), (await d.content.getSetting<string>(`walletOf:${p.handle}`)) ?? ""].filter(Boolean), emails: [(await d.content.getSetting<string>(`emailOf:${p.handle}`)) ?? ""].filter(Boolean) };
      const r = await d.feed.removePost(postId, { category: v.category, confidence: v.confidence, summary: v.summary, by: "ai", reportId: reportId ?? null, identity });
      d.log(`moderation: removed ${postId} (${v.category} ${v.confidence}) — ${v.summary}`);
      await d.feed.log("ai", "post.remove", `post:${postId}`, { verdict: v, reportId });
      if (r && r.count >= SUSPEND_AFTER) {
        await d.feed.suspendStore(r.handle, `${r.count} posts removed by moderation`);
        await d.feed.log("ai", "store.suspend", `store:${r.handle}`, { count: r.count });
        d.log(`moderation: suspended ${r.handle} after ${r.count} removals`);
      }
      await d.notify?.(p.handle, "A post was removed from your store", [`Our moderation removed a post: ${v.summary}`, "If you think this is a mistake, reply to this email — a person will look at it.",
        ...(r && r.count >= SUSPEND_AFTER ? [`Your store is paused after ${r.count} removed posts.`] : [])]).catch((e) => d.log(`moderation email: ${(e as Error).message}`));
    }
    if (reportId) await d.feed.decideReport(reportId, shouldRemove(v) ? "auto_removed" : "auto_kept", "ai", v);
    return v;
  }

  /** Search vector for a post / item / store; skipped when the text did not change. */
  async function embed(kind: "post" | "item" | "store", refId: string, handle: string, text: string): Promise<boolean> {
    const h = sha(text);
    if (!text.trim() || (await d.feed.vectorHash(kind, refId)) === h) return false;
    const env = await d.router.call({ capability: "embed", dataClass: "public", timeoutMs: 30_000, input: { input: [text] } });
    const vector = (env.output as { vectors?: number[][] }).vectors?.[0];
    if (!vector?.length) throw new Error("embed: no vector");
    await d.feed.putVector(kind, refId, handle, h, vector);
    return true;
  }
  async function indexStore(handle: string): Promise<void> {
    const b = await d.content.getBusiness(handle);
    if (!b) return;
    const summary = ((await d.content.getProfile(handle))?.data as { summary?: string } | undefined)?.summary ?? "";
    if (await moderateStoreProfile(handle, b.name, b.description)) return;
    await embed("store", handle, handle, [b.name, b.description, summary, [b.city, b.country].filter(Boolean).join(", ")].filter(Boolean).join("\n").slice(0, 4000));
    for (const i of await d.content.listItems(handle)) {
      if (await moderateItem(handle, i)) continue;
      await embed("item", i.id, handle, `${i.title}\n${i.description}`.slice(0, 2000));
    }
  }
  /** The store's own name and description: a clear violation pauses the store (checked once per text). */
  async function moderateStoreProfile(handle: string, name: string, description: string): Promise<boolean> {
    const h = sha(`${name}\n${description}`);
    const seen = await d.content.getSetting<{ hash: string; removed: boolean }>(`storeMod:${handle}`);
    if (seen?.hash === h) return seen.removed;
    const v = await moderatePost(ask(handle, "moderate"), { caption: `This is not a post: it is the store's name and its short "about" text, written by a new seller. Short or plain texts are normal. Judge only whether the store itself offers something the rules forbid.\nStore name: ${name}\nAbout the store: ${description}`, hashtags: [], store: name, storeDescription: description });
    // Pausing a whole store is heavy: only serious categories, only when the moderator is very sure (never "spam").
    const removed = v.violation && PROFILE_CATEGORIES.includes(v.category) && v.confidence >= 0.85;
    await d.content.setSetting(`storeMod:${handle}`, { hash: h, removed, category: v.category, confidence: v.confidence, summary: v.summary, at: v.at });
    if (removed) {
      const identity = { accounts: [d.accountOf(handle)], emails: [(await d.content.getSetting<string>(`emailOf:${handle}`)) ?? ""].filter(Boolean) };
      await d.feed.recordViolation("store", handle, identity, { category: v.category, confidence: v.confidence, summary: `store profile: ${v.summary}`, by: "ai" });
      await d.feed.suspendStore(handle, `store profile: ${v.summary}`.slice(0, 300));
      await d.feed.log("ai", "store.suspend", `store:${handle}`, { verdict: v });
      d.log(`moderation: paused store ${handle} (${v.category}) — ${v.summary}`);
      await d.notify?.(handle, "Your store was paused", [`Our moderation paused your store: ${v.summary}`, "If you think this is a mistake, reply to this email — a person will look at it."]).catch(() => {});
    }
    return removed;
  }
  /** Items for sale are checked like posts (title, description, photo). A removed item is hidden from the shop and
   *  counts as a violation; saving the same text again does not bring it back. Returns true when it is removed. */
  async function moderateItem(handle: string, i: { id: string; title: string; description: string; photoMediaId: string | null; kind: string; priceUnits: string; options: unknown }): Promise<boolean> {
    const h = sha(`${i.title}\n${i.description}\n${i.photoMediaId ?? ""}`);
    const seen = await d.content.getSetting<{ hash: string; removed: boolean; summary?: string }>(`itemMod:${i.id}`);
    let removed = seen?.hash === h ? seen.removed : null;
    let summary = seen?.summary ?? "";
    if (removed === null) {
      const b = await d.content.getBusiness(handle);
      const key = i.photoMediaId ? (await d.content.getMedia(i.photoMediaId))?.key : null;
      const image = key ? await photoDataUrl(join(d.mediaDir, key)).catch(() => null) : null;
      const v = await moderatePost(ask(handle, "moderate"), { caption: `Item for sale: ${i.title}\n${i.description}`, hashtags: [], store: b?.name ?? handle, storeDescription: b?.description ?? "", image });
      removed = shouldRemove(v); summary = v.summary;
      await d.content.setSetting(`itemMod:${i.id}`, { hash: h, removed, summary, category: v.category, confidence: v.confidence, at: v.at });
      if (removed) {
        const identity = { accounts: [d.accountOf(handle)], emails: [(await d.content.getSetting<string>(`emailOf:${handle}`)) ?? ""].filter(Boolean) };
        await d.feed.recordViolation("store", handle, identity, { category: v.category, confidence: v.confidence, summary: `item "${i.title}": ${v.summary}`, by: "ai" });
        await d.feed.log("ai", "item.remove", `item:${i.id}`, { verdict: v });
        d.log(`moderation: removed item ${i.id} (${v.category}) — ${v.summary}`);
        await d.notify?.(handle, "An item was removed from your store", [`Our moderation removed "${i.title}": ${v.summary}`, "If you think this is a mistake, reply to this email — a person will look at it."]).catch(() => {});
      }
    }
    if (removed) await d.content.upsertItem({ id: i.id, handle, kind: i.kind, title: i.title, description: i.description, priceUnits: i.priceUnits, options: (i.options as string[]) ?? [], photoMediaId: i.photoMediaId, active: false });
    return !!removed;
  }
  async function indexPost(postId: string): Promise<void> {
    const p = await d.content.getPost(postId);
    if (!p || p.status !== "published" || p.removedAt) return;
    const b = await d.content.getBusiness(p.handle);
    const item = p.itemId ? await d.content.getItem(p.handle, p.itemId) : null;
    await embed("post", p.id, p.handle, postSearchText(p, b?.name ?? "", item?.title));
  }
  async function place(handle: string): Promise<void> {
    const b = await d.content.getBusiness(handle);
    if (!b || b.placeBy === "owner") return;
    const summary = ((await d.content.getProfile(handle))?.data as { summary?: string } | undefined)?.summary ?? "";
    const pl = await findPlace(ask(handle, "place"), { name: b.name, description: b.description, summary, links: (b.links as string[]) ?? [] });
    await d.content.setPlace(handle, { ...pl, by: "ai" });
    d.log(`place: ${handle} → ${pl.city ?? "?"}, ${pl.country ?? "?"}, ships ${pl.ships ?? "?"}`);
  }

  const tasks: Record<string, Task> = {
    moderate_post: async (payload) => { const { postId, reportId } = payload as { postId: string; reportId?: number }; await moderate(postId, reportId ?? null); },
    // A store report: check its latest posts with the report; anything not about a post stays for a person.
    moderate_store: async (payload) => {
      const { handle, reportId } = payload as { handle: string; reportId: number };
      const posts = (await d.content.listPosts(handle, { status: ["published"], limit: 5 })).filter((p) => !p.removedAt);
      let removed = false;
      for (const p of posts) { const v = await moderate(p.id, null); if (v && shouldRemove(v)) removed = true; }
      await d.feed.decideReport(reportId, removed ? "auto_removed" : "open", "ai", { checkedPosts: posts.length, removed });
    },
    index_post: async (payload) => {
      const { postId } = payload as { postId: string };
      await indexPost(postId);
      const p = await d.content.getPost(postId);
      if (!p) return;
      // A new store gets its place with its first published post (the feed's region search needs it).
      if (!(await d.content.getBusiness(p.handle))?.placeBy) await place(p.handle).catch((e) => d.log(`place ${p.handle}: ${(e as Error).message}`));
      await indexStore(p.handle);
    },
    index_store: async (payload) => { await indexStore((payload as { handle: string }).handle); },
    find_place: async (payload) => { await place((payload as { handle: string }).handle); },
    // Once at start (and daily): places, vectors and moderation for everything published before this existed.
    feed_backfill: async (_payload, helpers) => {
      for (const b of await d.content.listBusinesses()) {
        if (!b.placeBy) await helpers.addJob("find_place", { handle: b.handle }, { jobKey: `place:${b.handle}`, maxAttempts: 2 });
        await helpers.addJob("index_store", { handle: b.handle }, { jobKey: `index-store:${b.handle}`, maxAttempts: 3 });
      }
      for (const p of await d.content.publishedPosts(500)) {
        await helpers.addJob("index_post", { postId: p.id }, { jobKey: `index:${p.id}`, maxAttempts: 3 });
        if (!p.moderation) await helpers.addJob("moderate_post", { postId: p.id }, { jobKey: `moderate:${p.id}`, maxAttempts: 3 });
      }
      await d.feed.pruneIps();
    },
  };
  return { tasks, moderate };
}
