// Buyers (ADR 0022): accounts by email link or any NEAR wallet (NEP-413), likes, reports, the feed API.
// The buyer cookie is separate from the seller cookie and signed with its own key.
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { REPORT_REASONS, type FeedPost, type FeedStore, type ReportReason } from "@nearchant/db";
import { RateLimit, clientIp } from "./buyers.js";
import { emailHtml, normEmail, readEmailToken, signEmailToken, type Mailer } from "./email.js";
import { verifyNep413 } from "./nep413.js";
import { readSession, signSession } from "./seller-app.js";

export const BUYER_COOKIE = "nc_buyer";
const BUYER_MS = 90 * 24 * 3600_000;

/** What a search turns into: the AI plan + a query vector (both optional: the feed works without AI). */
export interface SearchIntent { summary: string; terms: string[]; city: string | null; country: string | null; vector: number[] | null; goods?: string[] }

export interface BuyerAppDeps {
  feed: FeedStore;
  /** Lowest-cost surface of ContentStore the buyer side needs. */
  content: { getPost(id: string): Promise<{ id: string; handle: string; status: string; removedAt: Date | null } | null>; getSetting<T>(k: string): Promise<T | null>; setSetting(k: string, v: unknown): Promise<void>; getBusiness(h: string): Promise<{ handle: string } | null> };
  isOwnerKey: (accountId: string, publicKey: string) => Promise<boolean>;
  enqueue: (task: string, payload: Record<string, unknown>, jobKey?: string) => Promise<void>;
  /** Search planner + embedding (cached by the caller). */
  understand?: (q: string) => Promise<SearchIntent>;
  key: Buffer;
  secureCookies: boolean;
  walletRecipient: string;
  publicUrl: string;
  mail?: Mailer;
  now?: () => number;
}

/** Where a buyer may be sent back to after signing in: our own pages only. */
const safeBack = (b: unknown) => (typeof b === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(b) ? b : "/feed");

export function mountBuyerApp(app: Hono<any>, d: BuyerAppDeps): void {
  const now = () => (d.now ? d.now() : Date.now());
  const ipOf = (c: Context) => clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress);
  const buyerId = (c: Context) => readSession(d.key, getCookie(c, BUYER_COOKIE), now());
  const json = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const jsonOnly = (c: Context) => (c.req.header("content-type") ?? "").startsWith("application/json");
  const signIn = async (c: Context, id: string) => {
    setCookie(c, BUYER_COOKIE, signSession(d.key, id, now() + BUYER_MS), { httpOnly: true, sameSite: "Lax", secure: d.secureCookies, path: "/", maxAge: BUYER_MS / 1000 });
    await d.feed.logIp("buyer", id, ipOf(c));
  };
  /** The signed-in, not banned buyer, or null. */
  const buyer = async (c: Context) => { const id = buyerId(c); const b = id ? await d.feed.getBuyer(id) : null; return b && b.status === "active" ? b : null; };

  const perKey = new RateLimit(3, 15 * 60_000, now), perIp = new RateLimit(10, 3_600_000, now), reportIp = new RateLimit(10, 3_600_000, now), likeIp = new RateLimit(300, 3_600_000, now);

  // ── sign-in ──
  app.post("/api/buyer/email", async (c) => {
    if (!jsonOnly(c)) return c.json({ error: "JSON only" }, 415);
    if (!d.mail) return c.json({ error: "email sign-in is not set up on this server" }, 503);
    const b = await json(c), email = normEmail(String(b.email ?? ""));
    if (!email) return c.json({ error: "that doesn't look like an email address" }, 400);
    if (!perKey.take(`buyer:${email}`) || !perIp.take(ipOf(c))) return c.json({ error: "too many emails — try again in 15 minutes" }, 429);
    const back = safeBack(b.back);
    const url = `${d.publicUrl}/auth/buyer?t=${signEmailToken(d.key, { k: "signin", h: back, e: email, exp: now() + 15 * 60_000 })}`;
    const lines = ["Tap the button to sign in to Nearchant. The link works once, for 15 minutes.", "Signed in, you can like posts and report the ones that break the rules."];
    await d.mail({ to: email, subject: "Sign in to Nearchant", idempotencyKey: `buyer:${email}:${Math.floor(now() / 60_000)}`, text: `${lines.join("\n\n")}\n\n${url}\n\nDidn't ask for this? Ignore this email.`,
      html: emailHtml({ title: "Sign in to Nearchant", lines, button: { label: "Sign in", url }, foot: "Didn't ask for this? Ignore this email." }) });
    return c.json({ sent: true });
  });
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Nearchant</title><link rel="stylesheet" href="/assets/ui.css"></head><body><section class="onb" style="max-width:420px;margin:60px auto;padding:0 16px"><span class="logo" style="padding:0"><span class="mark">N</span>Nearchant</span><h1 class="t2">${title}</h1>${body}</section></body></html>`;
  app.get("/auth/buyer", (c) => {
    const t = c.req.query("t") ?? "";
    if (!readEmailToken(d.key, t, now())) return c.html(page("This link has expired", `<p class="sub muted">Ask for a new one on <a href="/feed">Nearchant</a>.</p>`), 400);
    return c.html(page("Sign in", `<p class="sub muted">Continue to Nearchant.</p><form method="post" action="/auth/buyer"><input type="hidden" name="t" value="${t.replace(/[^A-Za-z0-9._-]/g, "")}"><button class="btn block" type="submit">Sign in</button></form>`));
  });
  app.post("/auth/buyer", async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const tok = readEmailToken(d.key, String(form.t ?? ""), now());
    if (!tok) return c.html(page("This link has expired", `<p class="sub muted">Ask for a new one on <a href="/feed">Nearchant</a>.</p>`), 400);
    if (await d.content.getSetting(`emailTok:${tok.n}`)) return c.html(page("This link was used already", `<p class="sub muted">Each link works once. <a href="/feed">Back to Nearchant</a></p>`), 400);
    await d.content.setSetting(`emailTok:${tok.n}`, now());
    const b = await d.feed.buyerByEmail(tok.e);
    if (b.status !== "active") return c.html(page("This account is blocked", `<p class="sub muted">It broke the platform rules.</p>`), 403);
    await signIn(c, b.id);
    return c.redirect(safeBack(tok.h), 303);
  });
  const usedNonces = new Map<string, number>();
  app.post("/api/buyer/wallet", async (c) => {
    if (!jsonOnly(c)) return c.json({ error: "JSON only" }, 415);
    const b = await json(c);
    const accountId = String(b.accountId ?? "").toLowerCase(), publicKey = String(b.publicKey ?? ""), signature = String(b.signature ?? "");
    const message = String(b.message ?? ""), recipient = String(b.recipient ?? ""), callbackUrl = b.callbackUrl == null ? null : String(b.callbackUrl);
    const nonce = Buffer.from(String(b.nonce ?? ""), "base64");
    const m = /^nearchant:buyer:signin:(\d{13})$/.exec(message);
    if (!m || now() - Number(m[1]) > 10 * 60_000 || Number(m[1]) - now() > 60_000) return c.json({ error: "expired or malformed message" }, 401);
    if (recipient !== d.walletRecipient) return c.json({ error: "message is for another site" }, 401);
    if (nonce.length !== 32 || usedNonces.has(nonce.toString("hex"))) return c.json({ error: "nonce reused" }, 401);
    if (!/^[a-z0-9._-]{2,64}$/.test(accountId) || !verifyNep413({ message, nonce, recipient, callbackUrl }, publicKey, signature)) return c.json({ error: "bad signature" }, 401);
    usedNonces.set(nonce.toString("hex"), now());
    for (const [k, t] of usedNonces) if (now() - t > 20 * 60_000) usedNonces.delete(k);
    if (!(await d.isOwnerKey(accountId, publicKey))) return c.json({ error: "that key is not a full-access key of the wallet account" }, 403);
    const buyerRow = await d.feed.buyerByWallet(accountId);
    if (buyerRow.status !== "active") return c.json({ error: "this account is blocked for breaking the platform rules" }, 403);
    await signIn(c, buyerRow.id);
    return c.json({ buyer: buyerRow.id, wallet: accountId });
  });
  app.get("/api/buyer/me", async (c) => {
    const b = await buyer(c);
    if (!b) return c.json({ error: "not signed in" }, 401);
    void d.feed.touchBuyer(b.id);
    return c.json({ id: b.id, email: b.email, wallet: b.wallet });
  });
  app.post("/api/buyer/logout", (c) => { deleteCookie(c, BUYER_COOKIE, { path: "/" }); return c.json({ ok: true }); });

  // ── likes ──
  app.post("/api/feed/like", async (c) => {
    if (!jsonOnly(c)) return c.json({ error: "JSON only" }, 415);
    const b = await buyer(c);
    if (!b) return c.json({ error: "sign in to like posts", code: "signin" }, 401);
    if (!likeIp.take(ipOf(c))) return c.json({ error: "slow down" }, 429);
    const body = await json(c), postId = String(body.postId ?? "");
    const p = await d.content.getPost(postId);
    if (!p || p.status !== "published" || p.removedAt) return c.json({ error: "no such post" }, 404);
    const likes = await d.feed.like(b.id, postId, body.on !== false);
    void d.feed.logIp("buyer", b.id, ipOf(c));
    return c.json({ likes, liked: body.on !== false });
  });

  app.get("/api/feed/liked", async (c) => {
    const id = buyerId(c);
    const ids = (c.req.query("ids") ?? "").split(",").filter((x) => /^[\w-]{1,64}$/.test(x)).slice(0, 100);
    return c.json({ liked: id ? [...(await d.feed.likedBy(id, ids))] : [] });
  });

  // ── follows ──
  app.post("/api/store/follow", async (c) => {
    if (!jsonOnly(c)) return c.json({ error: "JSON only" }, 415);
    const b = await buyer(c);
    if (!b) return c.json({ error: "sign in to follow stores", code: "signin" }, 401);
    const body = await json(c), handle = String(body.handle ?? "");
    if (!(await d.content.getBusiness(handle))) return c.json({ error: "no such store" }, 404);
    const followers = await d.feed.follow(b.id, handle, body.on !== false);
    return c.json({ following: body.on !== false, followers });
  });
  app.get("/api/store/follow", async (c) => {
    const handle = c.req.query("handle") ?? "", id = buyerId(c);
    return c.json({ following: id ? await d.feed.follows(id, handle) : false, followers: await d.feed.followers(handle) });
  });

  // ── reports ──
  app.post("/api/report", async (c) => {
    if (!jsonOnly(c)) return c.json({ error: "JSON only" }, 415);
    const b = await buyer(c), ip = ipOf(c);
    if (!b) return c.json({ error: "sign in to report", code: "signin" }, 401);
    if (!reportIp.take(ip) || (await d.feed.recentReports({ buyerId: b.id })) >= 10) return c.json({ error: "too many reports — try again later" }, 429);
    const body = await json(c);
    const reason = String(body.reason ?? "") as ReportReason;
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) return c.json({ error: "pick a reason" }, 400);
    const postId = body.postId ? String(body.postId) : null;
    let handle = String(body.handle ?? "");
    if (postId) {
      const p = await d.content.getPost(postId);
      if (!p || p.status !== "published") return c.json({ error: "no such post" }, 404);
      if (p.removedAt) return c.json({ error: "this post was removed already — thank you" }, 409);
      handle = p.handle;
    } else if (!(await d.content.getBusiness(handle))) return c.json({ error: "no such store" }, 404);
    if (await d.feed.reportedBefore(b.id, { postId, handle })) return c.json({ error: "you reported this already — we're on it" }, 409);
    const id = await d.feed.addReport({ targetKind: postId ? "post" : "store", postId, handle, reporterBuyerId: b.id, reporterIp: ip, reason, note: String(body.note ?? "") });
    void d.feed.logIp("buyer", b.id, ip);
    await d.enqueue(postId ? "moderate_post" : "moderate_store", postId ? { postId, reportId: id } : { handle, reportId: id }, `report:${id}`);
    return c.json({ report: id });
  });

  // ── feed API (infinite scroll; the first page is rendered by /feed) ──
  app.get("/api/feed", async (c) => {
    const r = await feedFor(d, c.req.query("q") ?? "", buyerId(c), Number(c.req.query("offset") ?? 0) || 0, { city: c.req.query("city"), country: c.req.query("country"), visitorCountry: process.env.TRUST_PROXY === "cloudflare" ? c.req.header("cf-ipcountry") ?? null : null });
    return c.json(r);
  });
}

/** Runs a search (or "For you" without a query). Without AI it still works on words. */
export async function feedFor(d: Pick<BuyerAppDeps, "feed" | "understand">, q: string, buyerId: string | null, offset = 0, place: { city?: string | undefined; country?: string | undefined; visitorCountry?: string | null } = {}): Promise<{ intent: SearchIntent | null; posts: FeedPost[] }> {
  const query = q.trim().slice(0, 200), cityIn = place.city?.trim().slice(0, 60) || "";
  let intent: SearchIntent | null = null;
  if (query) {
    // The City box goes to the planner with the query, so it knows the country ("Austin" → US) and filters by it.
    const text = cityIn && !query.toLowerCase().includes(cityIn.toLowerCase()) ? `${query} in ${cityIn}` : query;
    try { intent = d.understand ? await d.understand(text) : null; } catch { intent = null; }
    intent ??= { summary: query, terms: query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1), city: null, country: null, vector: null };
  } else if (cityIn && d.understand) {
    // Only a city: everything from there (and stores that ship there), newest first.
    const where = await d.understand(`stores in ${cityIn}`).catch(() => null);
    intent = where ? { summary: `Stores for ${where.city ?? cityIn}`, terms: [], city: where.city ?? cityIn, country: where.country, vector: null } : null;
  }
  const city = cityIn || intent?.city || null, country = place.country?.trim().toUpperCase() || intent?.country || null;
  const visitor = /^[A-Z]{2}$/.test(place.visitorCountry ?? "") && place.visitorCountry !== "XX" && place.visitorCountry !== "T1" ? place.visitorCountry! : null;
  const posts = await d.feed.feed({ vector: intent?.vector ?? null, terms: intent?.terms ?? [], city, country, buyerId, offset, limit: 24, preferCountry: visitor });
  // Anonymous demand for sellers' Analytics: what was searched, where, what it found (no IP, no account).
  if (query && offset === 0 && intent && typeof d.feed.logSearch === "function") {
    void d.feed.logSearch({ q: query, goods: (intent as SearchIntent & { goods?: string[] }).goods?.length ? (intent as SearchIntent & { goods: string[] }).goods : [query.toLowerCase()], city, country, results: posts.length, handles: posts.map((p) => p.handle) }).catch(() => {});
  }
  return { intent: intent ? { ...intent, city, country, vector: null } : null, posts };
}
