// The seller app's JSON API (ADR 0018): session, business, photos, analysis, opportunities, posts, items.
// Pages call these with the session cookie set by POST /api/session (signed once with the store's NEAR key).
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import sharp from "sharp";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { safetyCurrent, safetyFlag } from "./post-safety.js";
import { parseContact } from "./contact.js";
import { parseDetails } from "./item-details.js";
import type { ContentStore } from "@nearchant/db";
import { QuotaExceeded } from "@nearchant/db";
import type { HandleRecord } from "@nearchant/near";
import { verifySellerSignature } from "./telegram.js";
import { RateLimit, clientIp } from "./buyers.js";
import { emailHtml, normEmail, readEmailToken, signEmailToken, type Mailer } from "./email.js";
import { verifyWalletSignature } from "./nep413.js";

/** The parts of the content store the API uses (a fake in tests, Postgres in the gateway). */
export type SellerContent = Pick<ContentStore,
  "upsertBusiness" | "getBusiness" | "completeOnboarding" | "getProfile" | "setProfile" | "addMedia" | "listMedia" | "getMedia" |
  "upsertItem" | "listItems" | "getItem" | "listOpportunities" | "chooseOpportunities" | "createPosts" | "listPosts" | "getPost" | "updatePost" |
  "choosePosts" | "addSignal" | "usage" | "setSetting" | "getSetting" | "reserve" | "refund" | "setPlace">;

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
  mirrorService?: (s: { id: string; handle: string; title: string; description: string; priceUnits: string; active?: boolean }) => Promise<void>;
  /** Paid item orders of a store + queue "shipped" (proof + mark_delivered via the outbox). */
  orders?: {
    list: (handle: string) => Promise<{ orderId: string; serviceId: string; amount: string; brief: string; state: string; createdAt: string }[]>;
    ship: (handle: string, orderId: string, note: string) => Promise<void>;
    /** The order on chain (the truth for money): Held, Delivered, RevisionRequested, RefundRequested, Disputed, … */
    status?: (orderId: string) => Promise<{ status: string } | null>;
    /** approve_refund (decline a paid order, or accept a refund request) / decline_refund, signed by the store's key. */
    refund?: (handle: string, orderId: string) => Promise<void>;
    declineRefund?: (handle: string, orderId: string) => Promise<void>;
  };
  /** NEAR AI Agent Market (ADR 0010): keep the store's market token + webhook secret (sealed). */
  marketConnect?: (handle: string, token: string, webhookSecret: string) => Promise<void>;
  /** NEP-413 recipient expected in wallet messages (the public host); default: the request's host. */
  walletRecipient?: string;
  /** Short videos can be made here (voice service + video renderer configured on the worker). */
  videoEnabled?: boolean;
  /** Token decimals for prices (nUSD: 6). */
  decimals: number;
  /** Outgoing email (ADR 0021): sign-in links. Absent → the email routes answer 503. */
  mail?: Mailer;
  /** Origin for links in emails (config public_url). */
  publicUrl?: string;
  /** IPs per store account, for the violators list (ADR 0022). */
  logIp?: (kind: "store", id: string, ip: string) => Promise<void>;
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

const NEW_WALLET = "nc_wallet_new";
function signNewWallet(key: Buffer, accountId: string, exp: number): string {
  const body = `${Buffer.from(accountId).toString("base64url")}.${exp}`;
  return `${body}.${createHmac("sha256", key).update(`wallet-new:${body}`).digest("base64url")}`;
}
function readNewWallet(key: Buffer, token: string | undefined, now: number): string | null {
  const m = token?.match(/^([\w-]+)\.(\d+)\.([\w-]+)$/);
  if (!m || Number(m[2]) < now) return null;
  const want = Buffer.from(createHmac("sha256", key).update(`wallet-new:${m[1]}.${m[2]}`).digest("base64url")), got = Buffer.from(m[3]!);
  return got.length === want.length && timingSafeEqual(got, want) ? Buffer.from(m[1]!, "base64url").toString() : null;
}

export function mountSellerApp(app: Hono<any>, d: SellerAppDeps): void {
  const now = () => (d.now ? d.now() : Date.now());
  const seller = (c: Context) => readSession(d.sessionKey, getCookie(c, COOKIE), now());
  const seenIp = new Map<string, number>();
  const authed = async (c: Context, fn: (handle: string) => Promise<Response>) => {
    const h = seller(c);
    if (!h) return c.json({ error: "sign in first" }, 401);
    if (d.logIp) { // at most once an hour per store and IP
      const ip = clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress), k = `${h}|${ip}`;
      if ((seenIp.get(k) ?? 0) < now() - 3_600_000) { seenIp.set(k, now()); if (seenIp.size > 20_000) seenIp.clear(); void d.logIp("store", h, ip).catch(() => {}); }
    }
    return fn(h);
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
  // "Connect a NEAR wallet" (Figma onboarding 1): the owner signs a NEP-413 message with their own wallet.
  //   purpose "link"   — while signed in: this wallet account may sign in to the store from now on;
  //   purpose "signin" — no session: the wallet account linked before signs in to its store.
  // The message is "nearchant:wallet:<purpose>:<ms>" (10 min), the recipient our host, a nonce is used once.
  const usedNonces = new Map<string, number>();
  app.post("/api/wallet/verify", async (c) => {
    // JSON only: a cross-site form (text/plain) must not be able to sign a visitor in to someone else's store.
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "JSON only" }, 415);
    const b = await json(c);
    const accountId = String(b.accountId ?? "").toLowerCase(), publicKey = String(b.publicKey ?? ""), signature = String(b.signature ?? "");
    const message = String(b.message ?? ""), recipient = String(b.recipient ?? ""), callbackUrl = b.callbackUrl == null ? null : String(b.callbackUrl);
    const nonce = Buffer.from(String(b.nonce ?? ""), "base64");
    const m = /^nearchant:wallet:(link|signin):(\d{13})$/.exec(message);
    if (!m || now() - Number(m[2]) > 10 * 60_000 || Number(m[2]) - now() > 60_000) return c.json({ error: "expired or malformed message" }, 401);
    if (recipient !== (d.walletRecipient ?? new URL(c.req.url).host)) return c.json({ error: "message is for another site" }, 401);
    if (nonce.length !== 32 || usedNonces.has(nonce.toString("hex"))) return c.json({ error: "nonce reused" }, 401);
    if (!/^[a-z0-9._-]{2,64}$/.test(accountId) || !verifyWalletSignature({ message, nonce, recipient, callbackUrl }, publicKey, signature)) return c.json({ error: "bad signature" }, 401);
    // Claim the nonce before the chain lookup, so two parallel requests can't both pass.
    usedNonces.set(nonce.toString("hex"), now());
    for (const [k, t] of usedNonces) if (now() - t > 20 * 60_000) usedNonces.delete(k);
    if (!(await d.isOwnerKey(accountId, publicKey))) return c.json({ error: "that key is not a full-access key of the wallet account" }, 403);
    if (m[1] === "link") {
      const handle = seller(c);
      if (!handle) return c.json({ error: "sign in to your store first" }, 401);
      const previous = await d.content.getSetting<string>(`walletOf:${handle}`);
      if (previous && previous !== accountId) await d.content.setSetting(`wallet:${previous}`, null); // re-link revokes the old one
      await d.content.setSetting(`wallet:${accountId}`, handle);
      await d.content.setSetting(`walletOf:${handle}`, accountId);
      return c.json({ linked: accountId, handle });
    }
    const handle = await d.content.getSetting<string>(`wallet:${accountId}`);
    if (!handle) {
      // Remember the proven wallet for 30 min (signed, HttpOnly): a store created next in this browser gets it.
      setCookie(c, NEW_WALLET, signNewWallet(d.sessionKey, accountId, now() + 30 * 60_000), { httpOnly: true, sameSite: "Lax", secure: d.secureCookies, path: "/", maxAge: 30 * 60 });
      return c.json({ error: `No store uses ${accountId} yet. Create one and this wallet will sign in to it — or, if you have a store, open it and go to Settings → Connect a NEAR wallet.`, code: "no_store", accountId }, 404);
    }
    setCookie(c, COOKIE, signSession(d.sessionKey, handle, now() + SESSION_MS), { httpOnly: true, sameSite: "Lax", secure: d.secureCookies, path: "/", maxAge: SESSION_MS / 1000 });
    return c.json({ handle });
  });
  // After "no store uses this wallet": the store just created in this browser takes the wallet, unless either side
  // already has one.
  app.post("/api/app/wallet/claim", (c) => authed(c, async (handle) => {
    const accountId = readNewWallet(d.sessionKey, getCookie(c, NEW_WALLET), now());
    if (!accountId || (await d.content.getSetting<string>(`walletOf:${handle}`)) || (await d.content.getSetting<string>(`wallet:${accountId}`))) return c.json({ linked: null });
    await d.content.setSetting(`wallet:${accountId}`, handle);
    await d.content.setSetting(`walletOf:${handle}`, accountId);
    deleteCookie(c, NEW_WALLET, { path: "/" });
    return c.json({ linked: accountId });
  }));
  // Email (ADR 0021): the owner links an email in Settings (confirm link), then can sign in with a one-time link.
  // Links open a page with one button (POST), so mail scanners that open links don't use them up. Unknown emails
  // get the same answer as known ones (no way to test which emails have stores).
  const emailPerKey = new RateLimit(3, 15 * 60_000, now), emailPerIp = new RateLimit(10, 3_600_000, now);
  const ipOf = (c: Context) => clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress);
  const sendLink = async (k: "link" | "signin", handle: string, email: string) => {
    const name = (await d.content.getBusiness(handle))?.name ?? handle;
    const exp = now() + (k === "link" ? 24 * 3600_000 : 15 * 60_000);
    const url = `${d.publicUrl ?? ""}/auth/email?t=${signEmailToken(d.sessionKey, { k, h: handle, e: email, exp })}`;
    const [subject, lines, label] = k === "link"
      ? [`Confirm your email for ${name}`, [`Tap the button to use ${email} for ${name} on Nearchant.`, "After that you can sign in from any browser with a link we email you."], "Confirm email"]
      : [`Sign in to ${name}`, [`Tap the button to sign in to ${name} on Nearchant. The link works once, for 15 minutes.`], "Sign in"];
    await d.mail!({ to: email, subject, idempotencyKey: `${k}:${handle}:${email}:${Math.floor(now() / 60_000)}`,
      text: `${lines.join("\n\n")}\n\n${url}\n\nDidn't ask for this? Ignore this email.`, html: emailHtml({ title: subject, lines, button: { label, url }, foot: "Didn't ask for this? Ignore this email — nothing changes." }) });
  };
  app.post("/api/app/email", (c) => authed(c, async (handle) => {
    if (!d.mail) return c.json({ error: "email is not set up on this server" }, 503);
    const email = normEmail(String((await json(c)).email ?? ""));
    if (!email) return c.json({ error: "that doesn't look like an email address" }, 400);
    if (!emailPerKey.take(`link:${handle}`) || !emailPerIp.take(ipOf(c))) return c.json({ error: "too many emails — try again in 15 minutes" }, 429);
    await sendLink("link", handle, email);
    return c.json({ sent: email });
  }));
  app.post("/api/email/signin", async (c) => {
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "JSON only" }, 415);
    if (!d.mail) return c.json({ error: "email sign-in is not set up on this server" }, 503);
    const email = normEmail(String((await json(c)).email ?? ""));
    if (!email) return c.json({ error: "that doesn't look like an email address" }, 400);
    if (!emailPerKey.take(`signin:${email}`) || !emailPerIp.take(ipOf(c))) return c.json({ error: "too many emails — try again in 15 minutes" }, 429);
    const handle = await d.content.getSetting<string>(`email:${email}`);
    if (handle) await sendLink("signin", handle, email);
    return c.json({ sent: true });
  });
  const linkPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Nearchant</title><link rel="stylesheet" href="/assets/ui.css"></head><body><section class="onb" style="max-width:420px;margin:60px auto;padding:0 16px"><span class="logo" style="padding:0"><span class="mark">N</span>Nearchant</span><h1 class="t2">${title}</h1>${body}</section></body></html>`;
  app.get("/auth/email", (c) => {
    const t = c.req.query("t") ?? "", tok = readEmailToken(d.sessionKey, t, now());
    if (!tok) return c.html(linkPage("This link has expired", `<p class="sub muted">Ask for a new one on the <a href="/app">sign-in page</a>.</p>`), 400);
    const label = tok.k === "link" ? "Confirm email" : "Sign in";
    return c.html(linkPage(label, `<p class="sub muted">${tok.k === "link" ? "Use this email for your store." : "Continue to your store."}</p><form method="post" action="/auth/email"><input type="hidden" name="t" value="${t.replace(/[^A-Za-z0-9._-]/g, "")}"><button class="btn block" type="submit">${label}</button></form>`));
  });
  app.post("/auth/email", async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const tok = readEmailToken(d.sessionKey, String(form.t ?? ""), now());
    if (!tok) return c.html(linkPage("This link has expired", `<p class="sub muted">Ask for a new one on the <a href="/app">sign-in page</a>.</p>`), 400);
    if (await d.content.getSetting(`emailTok:${tok.n}`)) return c.html(linkPage("This link was used already", `<p class="sub muted">Each link works once. <a href="/app">Sign in</a> again.</p>`), 400);
    await d.content.setSetting(`emailTok:${tok.n}`, now());
    if (tok.k === "link") {
      const prev = await d.content.getSetting<string>(`emailOf:${tok.h}`);
      if (prev && prev !== tok.e) await d.content.setSetting(`email:${prev}`, null); // the old email no longer signs in
      await d.content.setSetting(`email:${tok.e}`, tok.h);
      await d.content.setSetting(`emailOf:${tok.h}`, tok.e);
    } else if ((await d.content.getSetting<string>(`email:${tok.e}`)) !== tok.h) {
      return c.html(linkPage("This email is no longer linked", `<p class="sub muted">It was changed in the store's Settings.</p>`), 400);
    }
    setCookie(c, COOKIE, signSession(d.sessionKey, tok.h, now() + SESSION_MS), { httpOnly: true, sameSite: "Lax", secure: d.secureCookies, path: "/", maxAge: SESSION_MS / 1000 });
    return c.redirect(tok.k === "link" ? "/app/settings?email=linked#email" : "/app", 303);
  });
  app.post("/api/session/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.json({ ok: true }); });

  // Files: `<handle>/public/…` (published images) for everyone, anything else only for that store's owner.
  // NEAR AI TEE attestation reports cited by proofs on NEAR (attestation_ref "nearai:<model>:<sha256>"): public,
  // and the bytes hash to the name, so anyone can check the proof's report.
  app.get("/attestations/:file", async (c) => {
    const m = /^([0-9a-f]{64})(\.check)?\.json$/.exec(c.req.param("file"));
    if (!m) return c.notFound();
    const bytes = await readFile(join(d.mediaDir, "attestations", `${m[1]}${m[2] ?? ""}.json`)).catch(() => null);
    if (!bytes) return c.notFound();
    return c.body(bytes, 200, { "content-type": "application/json", "cache-control": m[2] ? "public, max-age=300" : "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
  });

  app.get("/files/*", async (c) => {
    const key = normalize(decodeURIComponent(c.req.path.slice("/files/".length)));
    const m = key.match(/^([a-z0-9_-]+)\/(photos|gen|public)\/[\w.-]+\.(jpg|png|webp|mp4)$/);
    if (!m) return c.notFound();
    if (m[2] !== "public" && seller(c) !== m[1]) return c.json({ error: "private" }, 403);
    // ?w=320|640|1024: a resized WebP of a picture (grids and thumbnails load ~50 KB instead of a 1.3 MB PNG),
    // made once and kept next to the media.
    const w = Number(c.req.query("w"));
    if ([320, 640, 1024].includes(w) && m[3] !== "mp4") {
      // The source's mtime is part of the key: a replaced item photo gets a new resized copy.
      const st = await stat(join(d.mediaDir, key)).catch(() => null);
      if (!st) return c.notFound();
      const thumb = join(d.mediaDir, ".thumbs", `${key}.${Math.floor(st.mtimeMs)}.${w}.webp`);
      let out: Uint8Array | null = await readFile(thumb).catch(() => null);
      if (!out) {
        const src = await readFile(join(d.mediaDir, key)).catch(() => null);
        if (!src) return c.notFound();
        out = new Uint8Array(await sharp(src).rotate().resize(w, w * 2, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer());
        await mkdir(join(thumb, ".."), { recursive: true });
        const tmp = `${thumb}.${randomUUID()}.tmp`; await writeFile(tmp, out); await rename(tmp, thumb); // never serve half a file
      }
      return c.body(out as Uint8Array<ArrayBuffer>, 200, { "content-type": "image/webp", "cache-control": m[2] === "public" ? "public, max-age=86400" : "private, max-age=3600", "x-content-type-options": "nosniff" });
    }
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

  // "Download all my data" (Settings → Your data): everything Nearchant keeps about the store, as one JSON file.
  app.get("/api/app/export", (c) => authed(c, async (handle) => {
    const [business, profile, items, posts, media, orders] = await Promise.all([d.content.getBusiness(handle), d.content.getProfile(handle), d.content.listItems(handle, false),
      d.content.listPosts(handle, { limit: 1000 }), d.content.listMedia(handle), d.orders ? d.orders.list(handle) : []]);
    const body = JSON.stringify({ exportedAt: new Date(d.now?.() ?? Date.now()).toISOString(), handle, business, profile, items, posts, orders,
      files: media.map((m) => ({ id: m.id, kind: m.kind, url: `/files/${m.key}` })) }, null, 2);
    return c.body(body, 200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="nearchant-${handle}.json"`, "cache-control": "no-store" });
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

  // Where the store is and ships (ADR 0022, shop feed region). The owner's choice is final; the AI never overwrites it.
  app.post("/api/app/place", (c) => authed(c, async (handle) => {
    const b = await json(c);
    const city = String(b.city ?? "").trim().slice(0, 60) || null, country = String(b.country ?? "").trim().toUpperCase() || null, ships = String(b.ships ?? "") || null;
    if (country && !/^[A-Z]{2}$/.test(country)) return c.json({ error: "country: a two-letter code, e.g. US" }, 400);
    if (ships && !["local", "country", "world"].includes(ships)) return c.json({ error: "ships: local, country or world" }, 400);
    await d.content.setPlace(handle, { city, country, ships, by: "owner" });
    await d.enqueue("index_store", { handle }, `index-store:${handle}`).catch(() => {});
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
      const plan = (await d.content.getBusiness(handle))?.plan ?? "free"; // a Pro store gets Pro limits
      const { batchId, ids } = await d.content.createPosts(handle, ideas, plan);
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
    await d.enqueue("check_post", { postId: p.id }, `check:${p.id}`); // the new caption gets its own check
    return c.json({ ok: true });
  }));
  // A 10–15 s video of a post (step 13b): 3 picture credits; the worker writes, renders, voices and cuts it.
  app.post("/api/app/posts/:id/video", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (!d.videoEnabled) return c.json({ error: "Videos are not available on this server yet" }, 503);
    if (!["ready", "scheduled", "published"].includes(p.status) || !(p.imageMediaId ?? p.sourceMediaId)) return c.json({ error: "the post needs a picture first" }, 409);
    const v = ((p.idea ?? {}) as { video?: { status?: string; startedAt?: number } }).video;
    // A video still "in progress" after 15 min was cut off (e.g. a worker restart): it may be started again.
    const inProgress = v && ["writing", "rendering"].includes(v.status ?? "");
    if (inProgress && now() - (v!.startedAt ?? now()) < 15 * 60_000) return c.json({ status: v!.status }, 202);
    try { await d.content.reserve(handle, 0, 3, (await d.content.getBusiness(handle))?.plan ?? "free"); }
    catch (e) { if (e instanceof QuotaExceeded) return c.json({ error: e.message, code: "quota_exceeded" }, 402); throw e; }
    // Restarting a cut-off video: the old run is superseded (it stops writing) and its credits come back.
    if (inProgress) await d.content.refund(handle, 0, 3);
    const runId = randomUUID();
    await d.content.updatePost(p.id, { idea: { ...(p.idea as object), video: { status: "writing", startedAt: now(), runId } } });
    await d.enqueue("make_video", { postId: p.id, runId }, `video:${p.id}:${runId}`);
    return c.json({ status: "writing" }, 202);
  }));
  // Caption chips: AI rewrites the caption shorter / playful / bolder (not after publishing — the proof is bound to it).
  // One post's live state for the editor and the "Publishing…" window (status, safety check, picture, video).
  app.get("/api/app/posts/:id", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    const m = p.imageMediaId ? await d.content.getMedia(p.imageMediaId) : null;
    const idea = (p.idea ?? {}) as Record<string, unknown>;
    return c.json({ id: p.id, status: p.status, removed: !!p.removedAt, removedReason: p.removedReason ?? null, proof: p.proof ?? null, caption: p.caption,
      imageUrl: m ? `/files/${m.key}` : null, needsChange: safetyFlag(p), safetyChecked: safetyCurrent(p) !== null,
      picture: idea.picture ?? null, rewrite: idea.rewrite ?? null, video: idea.video ?? null });
  }));
  // "New picture": the picture step again, optionally with the owner's change (1 picture credit).
  app.post("/api/app/posts/:id/picture", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (!["ready", "scheduled"].includes(p.status)) return c.json({ error: "a published post keeps its picture" }, 409);
    const pic = ((p.idea ?? {}) as { picture?: { status?: string; startedAt?: number } }).picture;
    if (pic?.status === "writing" && now() - (pic.startedAt ?? now()) < 10 * 60_000) return c.json({ status: "writing" }, 202);
    const instruction = String((await json(c)).instruction ?? "").trim().slice(0, 300);
    try { await d.content.reserve(handle, 0, 1, (await d.content.getBusiness(handle))?.plan ?? "free"); }
    catch (e) { if (e instanceof QuotaExceeded) return c.json({ error: e.message, code: "quota_exceeded" }, 402); throw e; }
    await d.content.updatePost(p.id, { idea: { ...(p.idea as object), picture: { status: "writing", startedAt: now() } } });
    await d.enqueue("remake_picture", { postId: p.id, ...(instruction ? { instruction } : {}) }, `picture:${p.id}:${now()}`);
    return c.json({ status: "writing" }, 202);
  }));
  // "Skip this post": it leaves the drafts (and the AI learns the owner passed on that angle).
  app.post("/api/app/posts/:id/skip", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (p.status === "published") return c.json({ error: "a published post can't be skipped" }, 409);
    await d.content.updatePost(p.id, { status: "skipped", passedAt: new Date(now()), scheduledAt: null });
    await d.content.addSignal(handle, p.id, "passed", { idea: p.idea });
    return c.json({ ok: true });
  }));
  app.post("/api/app/posts/:id/rewrite", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    const b = await json(c);
    const style = String(b.style ?? ""), instruction = String(b.instruction ?? "").trim().slice(0, 300);
    if (!["shorter", "playful", "bolder", "custom", "fix"].includes(style)) return c.json({ error: "style: shorter, playful, bolder, custom or fix" }, 400);
    if (style === "custom" && instruction.length < 3) return c.json({ error: "Tell the AI what to change (a few words)." }, 400);
    if (style === "fix" && !safetyFlag(p)) return c.json({ error: "Nothing to fix: the safety check is fine." }, 409);
    if (!["ready", "scheduled"].includes(p.status)) return c.json({ error: "a published post can't be rewritten" }, 409);
    if ((p.idea as { rewrite?: { status?: string } }).rewrite?.status === "writing") return c.json({ status: "writing" }, 202); // one at a time
    await d.content.updatePost(p.id, { idea: { ...(p.idea as object), rewrite: { status: "writing", style } } });
    await d.enqueue("rewrite_caption", { postId: p.id, style, ...(style === "custom" ? { instruction } : {}) }, `rewrite:${p.id}`);
    return c.json({ status: "writing" }, 202);
  }));
  app.post("/api/app/posts/:id/schedule", (c) => authed(c, async (handle) => {
    const p = await d.content.getPost(c.req.param("id"));
    if (!p || p.handle !== handle) return c.json({ error: "not found" }, 404);
    if (!["ready", "scheduled"].includes(p.status)) return c.json({ error: "post is not ready yet" }, 409);
    const flag = safetyFlag(p);
    if (flag) return c.json({ error: `Needs a small change first: ${flag}`, code: "needs_change" }, 409);
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

  // One order: decline & refund, answer a refund request, and messages with the buyer.
  const itemOrder = async (handle: string, id: string) => {
    const o = d.orders ? (await d.orders.list(handle)).find((x) => x.orderId === id) : undefined;
    return o && o.serviceId.startsWith("i-") ? o : null;
  };
  const REFUNDABLE = ["Held", "RevisionRequested", "RefundRequested", "Disputed"];
  app.post("/api/app/orders/:id/refund", (c) => authed(c, async (handle) => {
    const o = await itemOrder(handle, c.req.param("id"));
    if (!o || !d.orders?.refund || !d.orders.status) return c.json({ error: "not found" }, 404);
    const chain = await d.orders.status(o.orderId).catch(() => null);
    if (!chain || !REFUNDABLE.includes(chain.status)) return c.json({ error: chain?.status === "Refunded" ? "already refunded" : "this order can't be refunded now" }, 409);
    await d.orders.refund(handle, o.orderId);
    return c.json({ status: "refunding" }, 202);
  }));
  app.post("/api/app/orders/:id/decline-refund", (c) => authed(c, async (handle) => {
    const o = await itemOrder(handle, c.req.param("id"));
    if (!o || !d.orders?.declineRefund || !d.orders.status) return c.json({ error: "not found" }, 404);
    if ((await d.orders.status(o.orderId).catch(() => null))?.status !== "RefundRequested") return c.json({ error: "no refund request to decline" }, 409);
    await d.orders.declineRefund(handle, o.orderId);
    return c.json({ status: "declining" }, 202);
  }));

  // How buyers reach the store (ADR 0026): shown on the buyer's order page once they paid. Email or phone + app.
  app.post("/api/app/contact", (c) => authed(c, async (handle) => {
    const pc = parseContact(await json(c));
    if ("error" in pc) return c.json({ error: pc.error }, 400);
    const { name: _n, address: _a, ...contact } = pc.contact;
    await d.content.setSetting(`contactOf:${handle}`, contact);
    return c.json({ contact });
  }));
  // NEAR AI Agent Market (ADR 0010): the owner pastes the market token; the webhook secret is made here, shown once.
  app.post("/api/app/market", (c) => authed(c, async (handle) => {
    if (!d.marketConnect) return c.json({ error: "the market connection is off on this server" }, 503);
    const token = String((await json(c)).token ?? "").trim();
    if (!/^[\w.-]{10,400}$/.test(token)) return c.json({ error: "paste the API token from market.near.ai (it starts with aat_)" }, 400);
    const webhookSecret = `whsec_${randomUUID().replaceAll("-", "")}`;
    await d.marketConnect(handle, token, webhookSecret);
    await d.content.setSetting(`marketOn:${handle}`, new Date(now()).toISOString());
    return c.json({ webhookUrl: `${d.publicUrl ?? ""}/market/webhook/${handle}`, webhookSecret });
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

  // What the store sells (ADR 0026): products and services — add, edit, hide/unhide, fix with AI.
  app.get("/api/app/items", (c) => authed(c, async (handle) => c.json({ items: await d.content.listItems(handle, false) })));
  app.post("/api/app/items", (c) => authed(c, async (handle) => {
    const b = await json(c);
    const kind = b.kind === "service" ? "service" : "product";
    const title = String(b.title ?? "").trim().replace(/\s+/g, " "), price = Number(b.price);
    if (title.length < 2 || title.length > 120) return c.json({ error: "name: 2–120 characters" }, 400);
    if (!(price >= 0.5 && price <= 100_000)) return c.json({ error: "price: from 0.5 to 100,000" }, 400);
    const prev = b.id ? await d.content.getItem(handle, String(b.id)) : null;
    if (b.id && !prev) return c.json({ error: "not found" }, 404);
    const priceUnits = String(Math.round(price * 10 ** d.decimals)), description = String(b.description ?? "").trim().slice(0, 2000);
    const photoMediaId = b.photoMediaId ? String(b.photoMediaId) : null;
    if (photoMediaId && (await d.content.getMedia(photoMediaId))?.handle !== handle) return c.json({ error: "unknown photo" }, 400);
    const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
    const details = parseDetails(kind, b.details);
    const active = prev ? prev.active : true;
    // Saved text is checked again by the safety check (index_store); until then it is not held.
    const id = await d.content.upsertItem({ id: prev?.id, handle, kind, title, description, priceUnits, options: kind === "product" ? options : [], photoMediaId, active, details, held: null });
    await d.enqueue("index_store", { handle }, `index-store:${handle}:${Math.floor(now() / 10_000)}`).catch(() => {});
    // The item's photo is shown on the public storefront: publish a copy (the original stays private).
    if (photoMediaId) {
      const m = await d.content.getMedia(photoMediaId);
      if (m) { await mkdir(join(d.mediaDir, handle, "public"), { recursive: true }); await writeFile(join(d.mediaDir, handle, "public", `item-${id}.jpg`), await readFile(join(d.mediaDir, m.key))); }
    }
    await d.mirrorService?.({ id, handle, title, description, priceUnits, active });
    return c.json({ id }, prev ? 200 : 201);
  }));
  app.post("/api/app/items/:id/visibility", (c) => authed(c, async (handle) => {
    const it = await d.content.getItem(handle, c.req.param("id"));
    if (!it) return c.json({ error: "not found" }, 404);
    const active = (await json(c)).active === true;
    await d.content.upsertItem({ id: it.id, handle, kind: it.kind, title: it.title, description: it.description, priceUnits: it.priceUnits, options: (it.options as string[]) ?? [], photoMediaId: it.photoMediaId, active });
    await d.mirrorService?.({ id: it.id, handle, title: it.title, description: it.description, priceUnits: it.priceUnits, active });
    return c.json({ active });
  }));
  app.post("/api/app/items/:id/fix", (c) => authed(c, async (handle) => {
    const it = await d.content.getItem(handle, c.req.param("id"));
    if (!it) return c.json({ error: "not found" }, 404);
    if (!it.held) return c.json({ error: "nothing to fix — it is fine" }, 409);
    await d.enqueue("fix_item", { handle, itemId: it.id }, `fix-item:${it.id}:${Math.floor(now() / 60_000)}`);
    return c.json({ status: "fixing" }, 202);
  }));
}
