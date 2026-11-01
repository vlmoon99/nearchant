// The seller app's JSON API (ADR 0018): session, business, photos, analysis, opportunities, posts, items.
// Pages call these with the session cookie set by POST /api/session (signed once with the store's NEAR key).
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ContentStore } from "@nearchant/db";
import { QuotaExceeded } from "@nearchant/db";
import type { HandleRecord } from "@nearchant/near";
import { verifySellerSignature } from "./telegram.js";

/** The parts of the content store the API uses (a fake in tests, Postgres in the gateway). */
export type SellerContent = Pick<ContentStore,
  "upsertBusiness" | "getBusiness" | "completeOnboarding" | "getProfile" | "setProfile" | "addMedia" | "listMedia" | "getMedia" |
  "upsertItem" | "listItems" | "getItem" | "listOpportunities" | "chooseOpportunities" | "createPosts" | "listPosts" | "getPost" | "updatePost" |
  "choosePosts" | "addSignal" | "usage" | "setSetting" | "reserve">;

export interface SellerAppDeps {
  content: SellerContent;
  handles: { get(handle: string): Promise<HandleRecord | null> };
  isOwnerKey: (accountId: string, publicKey: string) => Promise<boolean>;
  /** Enqueue a worker job (graphile-worker addJob). */
  enqueue: (task: string, payload: Record<string, unknown>, jobKey?: string) => Promise<void>;
  mediaDir: string;
  /** HMAC key for session cookies (derived from NEARCHANT_SECRET_KEY). */
  sessionKey: Buffer;
  secureCookies: boolean;
  /** Mirror an item as an orderable service, so the existing escrow checkout sells it. */
  mirrorService?: (s: { id: string; handle: string; title: string; description: string; priceUnits: string }) => Promise<void>;
  /** Paid item orders of a store + queue "shipped" (proof + mark_delivered via the outbox). */
  orders?: { list: (handle: string) => Promise<{ orderId: string; serviceId: string; amount: string; brief: string; state: string; createdAt: string }[]>; ship: (handle: string, orderId: string, note: string) => Promise<void> };
  /** Short videos can be made here (voice service + video renderer configured on the worker). */
  videoEnabled?: boolean;
  /** Token decimals for prices (nUSD: 6). */
  decimals: number;
  now?: () => number;
}

const COOKIE = "nc_session";
const SESSION_MS = 30 * 24 * 3600_000;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PHOTO = 12 * 1024 * 1024;
const MAX_PHOTOS = 12;

export function signSession(key: Buffer, handle: string, exp: number): string {
  const body = `${handle}.${exp}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
export function readSession(key: Buffer, token: string | undefined, now = Date.now()): string | null {
  const m = token?.match(/^([a-z0-9_-]+)\.(\d+)\.([\w-]+)$/);
  if (!m || Number(m[2]) < now) return null;
  const want = createHmac("sha256", key).update(`${m[1]}.${m[2]}`).digest();
  const got = Buffer.from(m[3]!, "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? m[1]! : null;
}

export function mountSellerApp(app: Hono<any>, d: SellerAppDeps): void {
  const now = () => (d.now ? d.now() : Date.now());
  const seller = (c: Context) => readSession(d.sessionKey, getCookie(c, COOKIE), now());
  const authed = async (c: Context, fn: (handle: string) => Promise<Response>) => {
    const h = seller(c);
    return h ? fn(h) : c.json({ error: "sign in first" }, 401);
  };
  const json = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  // Session: the browser signs `nearchant:session:<handle>:<ms>` with a full-access key of the shop account.
  app.post("/api/session", async (c) => {
    const b = await json(c);
    const handle = String(b.handle ?? ""), message = String(b.message ?? ""), signature = String(b.signature ?? ""), publicKey = String(b.publicKey ?? "");
    const h = await d.handles.get(handle);
    if (!h) return c.json({ error: "unknown store" }, 404);
    if (!verifySellerSignature({ message, signature, publicKey, handle, action: "session", now: now() })) return c.json({ error: "bad or expired signature" }, 401);
    if (!(await d.isOwnerKey(h.account_id, publicKey))) return c.json({ error: "that key is not a full-access key of the store account" }, 403);
    setCookie(c, COOKIE, signSession(d.sessionKey, handle, now() + SESSION_MS), { httpOnly: true, sameSite: "Lax", secure: d.secureCookies, path: "/", maxAge: SESSION_MS / 1000 });
    return c.json({ handle });
  });
  app.post("/api/session/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.json({ ok: true }); });

  // Files: `<handle>/public/…` (published images) for everyone, anything else only for that store's owner.
  app.get("/files/*", async (c) => {
    const key = normalize(decodeURIComponent(c.req.path.slice("/files/".length)));
    const m = key.match(/^([a-z0-9_-]+)\/(photos|gen|public)\/[\w.-]+\.(jpg|png|webp|mp4)$/);
    if (!m) return c.notFound();
    if (m[2] !== "public" && seller(c) !== m[1]) return c.json({ error: "private" }, 403);
    const bytes = await readFile(join(d.mediaDir, key)).catch(() => null);
    if (!bytes) return c.notFound();
    const type = m[3] === "jpg" ? "image/jpeg" : m[3] === "mp4" ? "video/mp4" : `image/${m[3]}`;
    const headers: Record<string, string> = { "content-type": type, "cache-control": m[2] === "public" ? "public, max-age=86400" : "private, max-age=3600", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
    // Video players (Safari above all) fetch byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start >= bytes.length || start > end) return c.body(null, 416, { "content-range": `bytes */${bytes.length}` });
      return c.body(bytes.subarray(start, end + 1), 206, { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` });
    }
    return c.body(bytes, 200, headers);
  });

  app.get("/api/app/me", (c) => authed(c, async (handle) => {
    const [business, profile, usage] = await Promise.all([d.content.getBusiness(handle), d.content.getProfile(handle), d.content.usage(handle)]);
    return c.json({ handle, business, profile: profile && { status: profile.status, facts: profile.facts, data: profile.data, error: profile.error }, usage });
  }));

  app.post("/api/app/business", (c) => authed(c, async (handle) => {
    const b = await json(c);
    const name = String(b.name ?? "").trim(), kind = String(b.kind ?? "products"), description = String(b.description ?? "").trim();
    const links = (Array.isArray(b.links) ? b.links : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    if (name.length < 2 || name.length > 80) return c.json({ error: "store name: 2–80 characters" }, 400);
    if (!["products", "services", "both"].includes(kind)) return c.json({ error: "kind: products, services or both" }, 400);
    if (description.length > 600 || links.some((l) => l.length > 200)) return c.json({ error: "description up to 600 characters, links up to 200" }, 400);
    await d.content.upsertBusiness({ handle, name, kind, description, links, language: String(b.language ?? "en").slice(0, 5) });
    return c.json({ ok: true });
  }));

  // Photos: multipart `photo` fields (JPEG/PNG/WebP, ≤12 MB each, ≤12 per store for the analysis).
  app.post("/api/app/photos", (c) => authed(c, async (handle) => {
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const files = ([] as unknown[]).concat(form?.photo ?? []).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (!files.length) return c.json({ error: "add at least one photo (field: photo)" }, 400);
    const existing = (await d.content.listMedia(handle, "photo")).length;
    if (existing + files.length > MAX_PHOTOS) return c.json({ error: `up to ${MAX_PHOTOS} photos` }, 400);
    const ids: string[] = [];
    for (const f of files) {
      const ext = PHOTO_TYPES[f.type];
      if (!ext) return c.json({ error: "photos must be JPEG, PNG or WebP" }, 400);
      if (f.size > MAX_PHOTO) return c.json({ error: "each photo up to 12 MB" }, 400);
      const bytes = Buffer.from(await f.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `${handle}/photos/${randomUUID()}.${ext}`;
      await mkdir(join(d.mediaDir, handle, "photos"), { recursive: true });
      await writeFile(join(d.mediaDir, key), bytes);
      ids.push(await d.content.addMedia({ handle, kind: "photo", key, contentType: f.type, sha256 }));
    }
    return c.json({ ids }, 201);
  }));
  app.get("/api/app/photos", (c) => authed(c, async (handle) => c.json({ photos: (await d.content.listMedia(handle, "photo")).map((m) => ({ id: m.id, url: `/files/${m.key}` })) })));

  // Analysis ("Getting to know you"): the worker fills profile.facts as it goes; the page polls /api/app/me.
  app.post("/api/app/analyze", (c) => authed(c, async (handle) => {
    if (!(await d.content.getBusiness(handle))) return c.json({ error: "tell us about the business first" }, 400);
    if (!(await d.content.listMedia(handle, "photo")).length) return c.json({ error: "add a few photos first" }, 400);
    await d.content.setProfile(handle, { status: "analyzing", facts: [], error: null });
    await d.enqueue("analyze_business", { handle }, `analyze:${handle}`);
    return c.json({ status: "analyzing" }, 202);
  }));

  app.get("/api/app/opportunities", (c) => authed(c, async (handle) => c.json({ opportunities: await d.content.listOpportunities(handle) })));
  app.post("/api/app/opportunities/choose", (c) => authed(c, async (handle) => {
    const ids = ((await json(c)).ids as unknown[] | undefined ?? []).map(String).slice(0, 10);
    await d.content.chooseOpportunities(handle, ids);
    return c.json({ ok: true });
  }));

  // Posts: create a batch of options → the worker writes and renders them → the owner keeps some.
  app.post("/api/app/posts", (c) => authed(c, async (handle) => {
    const b = await json(c);
    const n = Math.min(Math.max(Number(b.n ?? 3) | 0, 1), 6);
    const opportunityIds = (Array.isArray(b.opportunityIds) ? b.opportunityIds : []).map(String);
    const ideas = Array.from({ length: n }, (_, i) => ({ opportunityId: opportunityIds[i % Math.max(opportunityIds.length, 1)] ?? null, itemId: b.itemId ? String(b.itemId) : null, idea: { about: String(b.about ?? "").slice(0, 300) } }));
    try {
      const { batchId, ids } = await d.content.createPosts(handle, ideas);
      await d.enqueue("generate_posts", { handle, batchId }, `posts:${batchId}`);
      return c.json({ batchId, ids }, 202);
    } catch (e) {
      if (e instanceof QuotaExceeded) return c.json({ error: e.message, code: "quota_exceeded" }, 402);
      throw e;
    }
  }));
  app.get("/api/app/posts", (c) => authed(c, async (handle) => {
    const posts = await d.content.listPosts(handle, { limit: 50 });
    const url = async (id: string | null) => { if (!id) return null; const m = await d.content.getMedia(id); return m ? `/files/${m.key}` : null; };
    return c.json({ posts: await Promise.all(posts.map(async (p) => ({ ...p, imageUrl: await url(p.imageMediaId) }))) });
  }));
  app.post("/api/app/posts/choose", (c) => authed(c, async (handle) => {
    const b = await json(c);
    await d.content.choosePosts(handle, String(b.batchId ?? ""), ((b.keep as unknown[]) ?? []).map(String));
    return c.json({ ok: true });
  }));
  app.post("/api/app/posts/:id/caption", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    const caption = String((await json(c)).caption ?? "").slice(0, 2200);
    await d.content.updatePost(p.id, { caption });
    await d.content.addSignal(handle, p.id, "edited", { before: p.caption, after: caption });
    return c.json({ ok: true });
  }));
  // A 10–15 s video of a post (step 13b): 3 picture credits; the worker writes, renders, voices and cuts it.
  app.post("/api/app/posts/:id/video", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (!d.videoEnabled) return c.json({ error: "Videos are not available on this server yet" }, 503);
    if (!["ready", "scheduled", "published"].includes(p.status) || !(p.imageMediaId ?? p.sourceMediaId)) return c.json({ error: "the post needs a picture first" }, 409);
    const v = ((p.idea ?? {}) as { video?: { status?: string } }).video;
    if (v && ["writing", "rendering"].includes(v.status ?? "")) return c.json({ status: v.status }, 202);
    try { await d.content.reserve(handle, 0, 3); }
    catch (e) { if (e instanceof QuotaExceeded) return c.json({ error: e.message, code: "quota_exceeded" }, 402); throw e; }
    await d.content.updatePost(p.id, { idea: { ...(p.idea as object), video: { status: "writing" } } });
    await d.enqueue("make_video", { postId: p.id }, `video:${p.id}:${now()}`);
    return c.json({ status: "writing" }, 202);
  }));
  app.post("/api/app/posts/:id/schedule", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (!["ready", "scheduled"].includes(p.status)) return c.json({ error: "post is not ready yet" }, 409);
    const at = new Date(String((await json(c)).at ?? ""));
    const when = Number.isNaN(at.getTime()) ? new Date(now()) : at;
    await d.content.updatePost(p.id, { status: "scheduled", scheduledAt: when, chosenAt: p.chosenAt ?? new Date(now()) });
    await d.enqueue("publish_post", { postId: p.id }, `publish:${p.id}`);
    return c.json({ status: "scheduled", at: when.toISOString() });
  }));

  // Orders of store items: the owner ships, then marks it shipped (recorded on NEAR; the buyer then confirms).
  app.get("/api/app/orders", (c) => authed(c, async (handle) => c.json({ orders: d.orders ? (await d.orders.list(handle)).filter((o) => o.serviceId.startsWith("i-")) : [] })));
  app.post("/api/app/orders/:id/ship", (c) => authed(c, async (handle) => {
    if (!d.orders) return c.json({ error: "orders are off on this gateway" }, 404);
    const o = (await d.orders.list(handle)).find((x) => x.orderId === c.req.param("id"));
    if (!o || !o.serviceId.startsWith("i-")) return c.json({ error: "not found" }, 404);
    if (o.state !== "paid") return c.json({ error: `order is ${o.state}` }, 409);
    await d.orders.ship(handle, o.orderId, String((await json(c)).note ?? "").slice(0, 300));
    return c.json({ status: "shipping" }, 202);
  }));

  // Settings: the owner's wishes for posts and pictures (kept across a new analysis), first-sale dismissal, insights.
  app.post("/api/app/profile/wishes", (c) => authed(c, async (handle) => {
    const wishes = String((await json(c)).wishes ?? "").slice(0, 500).trim();
    const prof = await d.content.getProfile(handle);
    await d.content.setProfile(handle, { data: { ...((prof?.data ?? {}) as object), wishes } });
    await d.content.addSignal(handle, null, "wishes", { wishes });
    return c.json({ ok: true });
  }));
  app.post("/api/app/celebrated", (c) => authed(c, async (handle) => { await d.content.setSetting(`celebrated:${handle}`, true); return c.json({ ok: true }); }));
  app.post("/api/app/insights", (c) => authed(c, async (handle) => { await d.enqueue("write_insights", { handle }, `insights:${handle}`); return c.json({ status: "writing" }, 202); }));

  // Items the store sells (products or services).
  app.get("/api/app/items", (c) => authed(c, async (handle) => c.json({ items: await d.content.listItems(handle, false) })));
  app.post("/api/app/items", (c) => authed(c, async (handle) => {
    const b = await json(c);
    const title = String(b.title ?? "").trim(), price = Number(b.price);
    if (title.length < 2 || title.length > 120) return c.json({ error: "title: 2–120 characters" }, 400);
    if (!(price > 0 && price <= 10_000)) return c.json({ error: "price must be above 0" }, 400);
    const priceUnits = String(Math.round(price * 10 ** d.decimals)), description = String(b.description ?? "").slice(0, 1000);
    const photoMediaId = b.photoMediaId ? String(b.photoMediaId) : null;
    const id = await d.content.upsertItem({ id: b.id ? String(b.id) : undefined, handle, kind: b.kind === "service" ? "service" : "product", title, description, priceUnits, options: (Array.isArray(b.options) ? b.options : []).map(String).slice(0, 20), photoMediaId });
    // The item's photo is shown on the public storefront: publish a copy (the original stays private).
    if (photoMediaId) {
      const m = await d.content.getMedia(photoMediaId);
      if (m && m.handle === handle) { await mkdir(join(d.mediaDir, handle, "public"), { recursive: true }); await writeFile(join(d.mediaDir, handle, "public", `item-${id}.jpg`), await readFile(join(d.mediaDir, m.key))); }
    }
    await d.mirrorService?.({ id, handle, title, description, priceUnits });
    return c.json({ id }, 201);
  }));
}
