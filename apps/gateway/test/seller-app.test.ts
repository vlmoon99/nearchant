import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { QuotaExceeded } from "@nearchant/db";
import type { HandleRecord } from "@nearchant/near";
import { mountSellerApp, readSession, signSession, type SellerContent } from "../src/seller-app.js";

const nova = { handle: "nova", account_id: "nova.nearchant.testnet" } as HandleRecord;

/** In-memory stand-in for ContentStore: only what the API touches. */
function fakeContent() {
  const db = { items: [] as any[], settings: new Map<string, any>(), lastPlan: undefined as string | undefined, business: new Map<string, any>(), profile: new Map<string, any>(), media: [] as any[], posts: [] as any[], signals: [] as any[], quota: 12 };
  const c: Partial<SellerContent> = {
    upsertBusiness: async (b) => { db.business.set(b.handle, b); if (!db.profile.has(b.handle)) db.profile.set(b.handle, { status: "none", facts: [] }); },
    getBusiness: async (h) => db.business.get(h) ?? null,
    getProfile: async (h) => db.profile.get(h) ?? null,
    setProfile: async (h, p) => { db.profile.set(h, { ...(db.profile.get(h) ?? {}), ...p }); },
    addMedia: async (m) => { const id = `m${db.media.length}`; db.media.push({ id, ...m }); return id; },
    listMedia: async (h, k) => db.media.filter((m) => m.handle === h && (!k || m.kind === k)),
    getMedia: async (id: string) => db.media.find((m) => m.id === id) ?? null,
    usage: async () => ({ posts: 12 - db.quota, images: 0 }),
    createPosts: async (h, ideas, plan) => { db.lastPlan = plan; if (ideas.length > db.quota) throw new QuotaExceeded("posts", 12); db.quota -= ideas.length; const ids = ideas.map((_, i) => `p${db.posts.length + i}`); ids.forEach((id) => db.posts.push({ id, handle: h, status: "ready" })); return { batchId: "b1", ids }; },
    listItems: async (h: string, activeOnly = true) => db.items.filter((i) => i.handle === h && (!activeOnly || (i.active && !i.held))),
    getItem: async (h: string, id: string) => db.items.find((i) => i.handle === h && i.id === id) ?? null,
    upsertItem: async (i: any) => { const id = i.id ?? `i-${db.items.length + 1}`; const old = db.items.find((x) => x.id === id); const v = { held: null, details: {}, ...(old ?? {}), ...Object.fromEntries(Object.entries(i).filter(([, x]) => x !== undefined)), id }; if (old) Object.assign(old, v); else db.items.push(v); return id; },
    listPosts: async (h) => db.posts.filter((p) => p.handle === h),
    getPost: async (id) => db.posts.find((p) => p.id === id) ?? null,
    updatePost: async (id, p) => { Object.assign(db.posts.find((x) => x.id === id), p); },
    addSignal: async (h, postId, kind) => { db.signals.push({ h, postId, kind }); },
    getSetting: async (k: string) => db.settings.get(k) ?? null,
    setSetting: async (k: string, v: unknown) => { db.settings.set(k, v); },
    refund: async (_h: string, _p: number, images: number) => { db.quota += images; },
    reserve: async (_h, _p, images) => { if (images > db.quota) throw new QuotaExceeded("images", 12); db.quota -= images; },
  };
  return { c: c as SellerContent, db };
}

// Item orders on a fake orders contract.
function orderDeps(chainStatus: Record<string, string>) {
  const calls: string[] = [];
  const list = async (h: string) => h !== "nova" ? [] : [
    { orderId: "o-new", serviceId: "i-1", amount: "5000000", brief: "Size M, 5th Ave", state: "paid", createdAt: "2026-11-08T10:00:00Z" },
    { orderId: "o-ask", serviceId: "i-1", amount: "5000000", brief: "", state: "delivered", createdAt: "2026-11-08T10:00:00Z" },
    { orderId: "o-sent", serviceId: "i-1", amount: "5000000", brief: "", state: "delivered", createdAt: "2026-11-08T10:00:00Z" },
    { orderId: "o-deck", serviceId: "deck", amount: "5000000", brief: "", state: "paid", createdAt: "2026-11-08T10:00:00Z" }];
  return { calls, deps: {
    orders: { list, ship: async () => {}, status: async (id: string) => (chainStatus[id] ? { status: chainStatus[id]! } : null),
      refund: async (_h: string, id: string) => { calls.push(`refund:${id}`); }, declineRefund: async (_h: string, id: string) => { calls.push(`decline:${id}`); } },
  } };
}

function setup(ownerKeys: string[] = [], videoEnabled = false, at = Date.now(), extra: Record<string, unknown> = {}) {
  const app = new Hono();
  const { c, db } = fakeContent();
  const jobs: { task: string; payload: unknown }[] = [];
  const mediaDir = mkdtempSync(join(tmpdir(), "nc-media-"));
  const key = Buffer.alloc(32, 7);
  const mails: { to: string; subject: string; text: string; idempotencyKey: string }[] = [];
  mountSellerApp(app, {
    mail: async (m) => { mails.push(m); }, publicUrl: "https://nearchant.com",
    content: c, handles: { get: async (h) => (h === "nova" ? nova : null) }, isOwnerKey: async (_a, pk) => ownerKeys.includes(pk),
    enqueue: async (task, payload) => { jobs.push({ task, payload }); }, mediaDir, sessionKey: key, secureCookies: false, decimals: 6, videoEnabled, walletRecipient: "nearchant.com", now: () => at, ...extra,
  });
  const cookie = `nc_session=${signSession(key, "nova", Date.now() + 60_000)}`;
  return { app, db, jobs, mediaDir, cookie, key, mails };
}

const post = (body: unknown, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

describe("email sign-in", () => {
  const linkOf = (text: string) => /https:\/\/nearchant\.com(\/auth\/email\?t=[A-Za-z0-9._-]+)/.exec(text)![1]!;
  const confirm = async (app: Hono, path: string) => {
    const t = new URL(`http://x${path}`).searchParams.get("t")!;
    return app.request("http://x/auth/email", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` });
  };

  it("links an email with a confirm link, then signs in with a one-time link", async () => {
    const { app, cookie, db, mails } = setup();
    db.business.set("nova", { handle: "nova", name: "Nova Wear" });
    expect((await app.request("http://x/api/app/email", post({ email: "owner@example.com" }))).status).toBe(401);
    expect((await app.request("http://x/api/app/email", post({ email: "not-an-email" }, cookie))).status).toBe(400);
    expect((await app.request("http://x/api/app/email", post({ email: "Owner@Example.com" }, cookie))).status).toBe(200);
    expect(mails[0]).toMatchObject({ to: "owner@example.com", subject: "Confirm your email for Nova Wear" });
    const link = linkOf(mails[0]!.text);
    // Opening the link (or a mail scanner opening it) only shows a button; it does not use the link up.
    const page = await app.request(`http://x${link}`);
    expect(await page.text()).toContain('action="/auth/email"');
    const ok = await confirm(app, link);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("set-cookie")).toMatch(/nc_session=nova\./);
    expect(db.settings.get("email:owner@example.com")).toBe("nova");
    expect((await confirm(app, link)).status).toBe(400); // once only

    // Sign in from another browser: unknown emails get the same answer and no mail.
    const unknown = await app.request("http://x/api/email/signin", post({ email: "stranger@example.com" }));
    expect(await unknown.json()).toEqual({ sent: true });
    expect(mails).toHaveLength(1);
    const r = await app.request("http://x/api/email/signin", post({ email: "owner@example.com" }));
    expect(await r.json()).toEqual({ sent: true });
    expect(mails[1]!.subject).toBe("Sign in to Nova Wear");
    const s = await confirm(app, linkOf(mails[1]!.text));
    expect(s.headers.get("location")).toBe("/app");
    expect(s.headers.get("set-cookie")).toMatch(/nc_session=nova\./);
  });

  it("refuses form posts to the JSON endpoint, forged or stale links, and too many emails", async () => {
    const { app, cookie, db, mails } = setup();
    expect((await app.request("http://x/api/email/signin", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"email":"a@b.co"}' })).status).toBe(415);
    expect((await app.request("http://x/auth/email", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "t=abc.def" })).status).toBe(400);
    for (let i = 0; i < 3; i++) await app.request("http://x/api/app/email", post({ email: "owner@example.com" }, cookie));
    expect((await app.request("http://x/api/app/email", post({ email: "owner@example.com" }, cookie))).status).toBe(429);
    // A sign-in link stops working when the store changes its email.
    db.settings.set("email:owner@example.com", "nova");
    await app.request("http://x/api/email/signin", post({ email: "owner@example.com" }));
    db.settings.set("email:owner@example.com", null);
    expect((await confirm(app, linkOf(mails.at(-1)!.text))).status).toBe(400);
  });
});

describe("seller session", () => {
  it("signs and reads session tokens, rejecting tampering and expiry", () => {
    const k = Buffer.alloc(32, 1);
    const t = signSession(k, "nova", Date.now() + 1000);
    expect(readSession(k, t)).toBe("nova");
    expect(readSession(k, t.replace("nova", "evil"))).toBeNull();
    expect(readSession(Buffer.alloc(32, 2), t)).toBeNull();
    expect(readSession(k, signSession(k, "nova", Date.now() - 1))).toBeNull();
  });

  it("logs in with a signature from a full-access key of the store account", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    const pk = kp.getPublicKey().toString();
    const { app } = setup([pk]);
    const message = `nearchant:session:nova:${Date.now()}`;
    const signature = Buffer.from(kp.sign(new TextEncoder().encode(message)).signature).toString("base64");
    const ok = await app.request("http://x/api/session", post({ handle: "nova", message, signature, publicKey: pk }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/nc_session=nova\.\d+\./);
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly/);
    // A valid signature from a key that is not on the account is refused.
    const other = KeyPair.fromRandom("ed25519");
    const sig2 = Buffer.from(other.sign(new TextEncoder().encode(message)).signature).toString("base64");
    expect((await app.request("http://x/api/session", post({ handle: "nova", message, signature: sig2, publicKey: other.getPublicKey().toString() }))).status).toBe(403);
    // A signature for another action is refused.
    const m3 = `nearchant:dashboard:nova:${Date.now()}`;
    const sig3 = Buffer.from(kp.sign(new TextEncoder().encode(m3)).signature).toString("base64");
    expect((await app.request("http://x/api/session", post({ handle: "nova", message: m3, signature: sig3, publicKey: pk }))).status).toBe(401);
  });
});

describe("seller API", () => {
  it("needs a session", async () => {
    const { app } = setup();
    expect((await app.request("http://x/api/app/me")).status).toBe(401);
    expect((await app.request("http://x/api/app/business", post({ name: "Nova" }))).status).toBe(401);
  });

  it("saves the business with validation", async () => {
    const { app, db, cookie } = setup();
    expect((await app.request("http://x/api/app/business", post({ name: "N" }, cookie))).status).toBe(400);
    expect((await app.request("http://x/api/app/business", post({ name: "Nova Wear", kind: "robots" }, cookie))).status).toBe(400);
    const r = await app.request("http://x/api/app/business", post({ name: "Nova Wear", kind: "products", description: "Relaxed clothes", links: ["instagram.com/novawear", ""] }, cookie));
    expect(r.status).toBe(200);
    expect(db.business.get("nova").links).toEqual(["instagram.com/novawear"]);
  });

  it("downloads all of the store's data only for its owner", async () => {
    const { app, cookie } = setup();
    expect((await app.request("http://x/api/app/export")).status).toBe(401);
    await app.request("http://x/api/app/business", post({ name: "Nova Wear", kind: "products", description: "Relaxed clothes" }, cookie));
    const r = await app.request("http://x/api/app/export", { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain('nearchant-nova.json');
    const j = await r.json() as { handle: string; business: { name: string }; posts: unknown[]; files: unknown[] };
    expect(j.handle).toBe("nova"); expect(j.business.name).toBe("Nova Wear");
    expect(Array.isArray(j.posts) && Array.isArray(j.files)).toBe(true);
  });

  it("stores photos privately and serves them only to the owner", async () => {
    const { app, cookie, mediaDir, db } = setup();
    const fd = new FormData();
    fd.append("photo", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" }));
    const r = await app.request("http://x/api/app/photos", { method: "POST", headers: { cookie }, body: fd });
    expect(r.status).toBe(201);
    const key = db.media[0].key as string;
    expect(readFileSync(join(mediaDir, key)).length).toBe(4);
    expect((await app.request(`http://x/files/${key}`, { headers: { cookie } })).status).toBe(200);
    expect((await app.request(`http://x/files/${key}`)).status).toBe(403);
    expect((await app.request(`http://x/files/nova/photos/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie } })).status).toBe(404);
    const bad = new FormData();
    bad.append("photo", new File(["x"], "a.gif", { type: "image/gif" }));
    expect((await app.request("http://x/api/app/photos", { method: "POST", headers: { cookie }, body: bad })).status).toBe(400);
  });

  it("starts the analysis only with a business and photos", async () => {
    const { app, cookie, jobs } = setup();
    expect((await app.request("http://x/api/app/analyze", post({}, cookie))).status).toBe(400);
    await app.request("http://x/api/app/business", post({ name: "Nova Wear" }, cookie));
    expect((await app.request("http://x/api/app/analyze", post({}, cookie))).status).toBe(400);
    const fd = new FormData();
    fd.append("photo", new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
    await app.request("http://x/api/app/photos", { method: "POST", headers: { cookie }, body: fd });
    const r = await app.request("http://x/api/app/analyze", post({}, cookie));
    expect(r.status).toBe(202);
    expect(jobs).toEqual([{ task: "analyze_business", payload: { handle: "nova" } }]);
  });

  it("queues post batches and answers 402 when the month's quota is used", async () => {
    const { app, cookie, jobs } = setup();
    const r = await app.request("http://x/api/app/posts", post({ n: 6 }, cookie));
    expect(r.status).toBe(202);
    expect(jobs[0]?.task).toBe("generate_posts");
    await app.request("http://x/api/app/posts", post({ n: 6 }, cookie));
    const over = await app.request("http://x/api/app/posts", post({ n: 1 }, cookie));
    expect(over.status).toBe(402);
    expect((await over.json() as { code: string }).code).toBe("quota_exceeded");
  });

  it("schedules only ready posts of the owner", async () => {
    const { app, cookie, db, jobs } = setup();
    await app.request("http://x/api/app/posts", post({ n: 1 }, cookie));
    db.posts.push({ id: "theirs", handle: "other", status: "ready" });
    expect((await app.request("http://x/api/app/posts/theirs/schedule", post({}, cookie))).status).toBe(404);
    const r = await app.request("http://x/api/app/posts/p0/schedule", post({ at: "2026-11-07T16:00:00Z" }, cookie));
    expect(r.status).toBe(200);
    expect(db.posts[0].status).toBe("scheduled");
    expect(jobs.at(-1)?.task).toBe("publish_post");
  });

  it("makes a video of a post with a picture: 3 credits, one job, no double start", async () => {
    const off = setup();
    off.db.posts.push({ id: "v0", handle: "nova", status: "ready", imageMediaId: "m1", idea: {} });
    expect((await off.app.request("http://x/api/app/posts/v0/video", post({}, off.cookie))).status).toBe(503);
    const { app, cookie, db, jobs } = setup([], true);
    db.posts.push({ id: "v0", handle: "nova", status: "ready", imageMediaId: "m1", idea: { angle: "a" } }, { id: "v1", handle: "nova", status: "ready", imageMediaId: null, idea: {} });
    expect((await app.request("http://x/api/app/posts/v1/video", post({}, cookie))).status).toBe(409);
    expect((await app.request("http://x/api/app/posts/v0/video", post({}, cookie))).status).toBe(202);
    expect(db.quota).toBe(9);
    expect(db.posts[0].idea).toMatchObject({ angle: "a", video: { status: "writing" } });
    expect(jobs.filter((j) => j.task === "make_video")).toHaveLength(1);
    expect((await app.request("http://x/api/app/posts/v0/video", post({}, cookie))).status).toBe(202);
    expect(db.quota).toBe(9); // already making: no second job, no second charge
    expect(jobs.filter((j) => j.task === "make_video")).toHaveLength(1);
  });

  it("serves a store's video with byte ranges, privately until published", async () => {
    const { app, cookie, mediaDir } = setup();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(mediaDir, "nova", "gen"), { recursive: true });
    writeFileSync(join(mediaDir, "nova", "gen", "p1.mp4"), Buffer.from("0123456789"));
    expect((await app.request("http://x/files/nova/gen/p1.mp4")).status).toBe(403);
    const full = await app.request("http://x/files/nova/gen/p1.mp4", { headers: { cookie } });
    expect(full.headers.get("content-type")).toBe("video/mp4");
    const part = await app.request("http://x/files/nova/gen/p1.mp4", { headers: { cookie, range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect((await app.request("http://x/files/nova/gen/p1.mp4", { headers: { cookie, range: "bytes=20-" } })).status).toBe(416);
  });

  it("serves attestation reports by their sha256 only", async () => {
    const { app, mediaDir } = setup();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const h = "ab".repeat(32);
    mkdirSync(join(mediaDir, "attestations"), { recursive: true });
    writeFileSync(join(mediaDir, "attestations", `${h}.json`), '{"signing_address":"0xabc"}');
    const r = await app.request(`http://x/attestations/${h}.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect((await app.request("http://x/attestations/..%2Fsecret.json")).status).toBe(404);
    expect((await app.request(`http://x/attestations/${"cd".repeat(32)}.json`)).status).toBe(404);
  });

  it("a caption edit queues a fresh caption check", async () => {
    const { app, cookie, db, jobs } = setup();
    db.posts.push({ id: "c0", handle: "nova", status: "ready", caption: "old", idea: {} });
    expect((await app.request("http://x/api/app/posts/c0/caption", post({ caption: "50% off today!" }, cookie))).status).toBe(200);
    expect(jobs.at(-1)).toEqual({ task: "check_post", payload: { postId: "c0" } });
  });

  it("uses the store's plan for the monthly limits", async () => {
    const { app, cookie, db } = setup();
    db.business.set("nova", { handle: "nova", name: "Nova", plan: "pro" });
    await app.request("http://x/api/app/posts", post({ n: 1 }, cookie));
    expect(db.lastPlan).toBe("pro");
  });

  it("NEAR wallet: link while signed in, then sign in with it; expired, foreign and replayed messages fail", async () => {
    const { KeyPair } = await import("near-api-js");
    const { randomBytes } = await import("node:crypto");
    const { walletSign } = await import("./wallet-helper.js");
    const wallet = KeyPair.fromRandom("ed25519"), pk = wallet.getPublicKey().toString(), at = 1_790_000_000_000;
    const { app, cookie, db } = setup([pk], false, at);
    const body = (purpose: string, extra: Record<string, unknown> = {}) => {
      const p = { message: `nearchant:wallet:${purpose}:${at}`, nonce: randomBytes(32), recipient: "nearchant.com", callbackUrl: "https://nearchant.com/app/wallet", ...extra } as any;
      return { accountId: "owner.testnet", publicKey: pk, signature: walletSign(wallet, p), message: p.message, nonce: Buffer.from(p.nonce).toString("base64"), recipient: p.recipient, callbackUrl: p.callbackUrl };
    };
    expect((await app.request("http://x/api/wallet/verify", post(body("signin")))).status).toBe(404);    // nothing linked yet
    expect((await app.request("http://x/api/wallet/verify", post(body("link")))).status).toBe(401);      // link needs a session
    const linked = await app.request("http://x/api/wallet/verify", post(body("link"), cookie));
    expect(await linked.json()).toEqual({ linked: "owner.testnet", handle: "nova" });
    expect(db.settings.get("walletOf:nova")).toBe("owner.testnet");
    const signin = await app.request("http://x/api/wallet/verify", post(body("signin")));
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-cookie")).toMatch(/nc_session=nova\./);
    expect((await app.request("http://x/api/wallet/verify", post(body("signin", { recipient: "evil.com" })))).status).toBe(401);
    const old = body("signin"); old.message = `nearchant:wallet:signin:${at - 11 * 60_000}`;
    expect((await app.request("http://x/api/wallet/verify", post(old))).status).toBe(401);
    const once = body("signin");
    expect((await app.request("http://x/api/wallet/verify", post(once))).status).toBe(200);
    expect((await app.request("http://x/api/wallet/verify", post(once))).status).toBe(401);           // nonce replay
  });

  it("wallet with no store: says so, then a store made in the same browser gets that wallet", async () => {
    const { KeyPair } = await import("near-api-js");
    const { randomBytes } = await import("node:crypto");
    const { walletSign } = await import("./wallet-helper.js");
    const wallet = KeyPair.fromRandom("ed25519"), pk = wallet.getPublicKey().toString(), at = 1_790_000_000_000;
    const { app, cookie, db } = setup([pk], false, at);
    const p = { message: `nearchant:wallet:signin:${at}`, nonce: randomBytes(32), recipient: "nearchant.com", callbackUrl: null } as any;
    const res = await app.request("http://x/api/wallet/verify", post({ accountId: "fresh.testnet", publicKey: pk, signature: walletSign(wallet, p), message: p.message, nonce: Buffer.from(p.nonce).toString("base64"), recipient: p.recipient, callbackUrl: null }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_store");
    const pending = /nc_wallet_new=[^;]+/.exec(res.headers.get("set-cookie") ?? "")![0];
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    const claim = (h: Record<string, string>) => app.request("http://x/api/app/wallet/claim", { method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });
    expect((await claim({ cookie: pending })).status).toBe(401);                                    // needs a store session
    expect(await (await claim({ cookie })).json()).toEqual({ linked: null });                           // no pending wallet
    expect(await (await claim({ cookie: `${pending.slice(0, -1)}${pending.endsWith("A") ? "B" : "A"}; ${cookie}` })).json()).toEqual({ linked: null }); // tampered
    const ok = await claim({ cookie: `${pending}; ${cookie}` });
    expect(await ok.json()).toEqual({ linked: "fresh.testnet" });
    expect(db.settings.get("wallet:fresh.testnet")).toBe("nova");
    expect(db.settings.get("walletOf:nova")).toBe("fresh.testnet");
    db.settings.set("walletOf:nova", "other.testnet");                                              // never replaces a wallet already set
    expect(await (await claim({ cookie: `${pending}; ${cookie}` })).json()).toEqual({ linked: null });
  });

  it("serves a resized WebP of a picture with ?w=, cached on disk", async () => {
    const { app, cookie, mediaDir } = setup();
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const sharp = (await import("sharp")).default;
    mkdirSync(join(mediaDir, "nova", "gen"), { recursive: true });
    writeFileSync(join(mediaDir, "nova", "gen", "p1.png"), await sharp({ create: { width: 1024, height: 1280, channels: 3, background: "#a83232" } }).png().toBuffer());
    const r = await app.request("http://x/files/nova/gen/p1.png?w=320", { headers: { cookie } });
    expect(r.headers.get("content-type")).toBe("image/webp");
    const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([320, 400]);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(mediaDir, ".thumbs", "nova/gen")).some((f) => /^p1\.png\.\d+\.320\.webp$/.test(f))).toBe(true); // keyed by the source's mtime
    expect((await app.request("http://x/files/nova/gen/p1.png?w=320")).status).toBe(403);   // still private
    expect((await app.request("http://x/files/nova/gen/p1.png?w=999", { headers: { cookie } })).headers.get("content-type")).toBe("image/png");
  });

  it("caption chips: rewrite ready posts in a style; never a published one", async () => {
    const { app, cookie, db, jobs } = setup();
    db.posts.push({ id: "r0", handle: "nova", status: "ready", caption: "c", idea: {} }, { id: "r1", handle: "nova", status: "published", caption: "c", idea: {} });
    expect((await app.request("http://x/api/app/posts/r0/rewrite", post({ style: "louder" }, cookie))).status).toBe(400);
    expect((await app.request("http://x/api/app/posts/r1/rewrite", post({ style: "shorter" }, cookie))).status).toBe(409);
    expect((await app.request("http://x/api/app/posts/r0/rewrite", post({ style: "shorter" }, cookie))).status).toBe(202);
    expect(db.posts[0].idea.rewrite).toEqual({ status: "writing", style: "shorter" });
    expect(jobs.filter((j) => j.task === "rewrite_caption")).toHaveLength(1);
  });

  it("orders: decline & refund a paid order, answer a refund request — store items only", async () => {
    const o = orderDeps({ "o-new": "Held", "o-ask": "RefundRequested", "o-sent": "Delivered", "o-deck": "Held" });
    const { app, cookie } = setup([], false, Date.now(), o.deps);
    expect((await app.request("http://x/api/app/orders/o-new/refund", post({}))).status).toBe(401);                     // the owner only
    expect((await app.request("http://x/api/app/orders/o-new/refund", post({}, cookie))).status).toBe(202);            // decline & refund
    expect((await app.request("http://x/api/app/orders/o-sent/refund", post({}, cookie))).status).toBe(409);           // shipped: the buyer decides
    expect((await app.request("http://x/api/app/orders/o-deck/refund", post({}, cookie))).status).toBe(404);           // not a store item
    expect((await app.request("http://x/api/app/orders/o-new/decline-refund", post({}, cookie))).status).toBe(409);    // nothing asked
    expect((await app.request("http://x/api/app/orders/o-ask/decline-refund", post({}, cookie))).status).toBe(202);
    expect((await app.request("http://x/api/app/orders/o-ask/refund", post({}, cookie))).status).toBe(202);            // approve the request
    expect(o.calls).toEqual(["refund:o-new", "decline:o-ask", "refund:o-ask"]);
    expect((await app.request("http://x/api/app/orders/o-new/messages", post({ text: "hi" }, cookie))).status).toBe(404); // no in-app chat (ADR 0026)
  });

  it("shop: add a product and a service, edit, hide and show again, fix with AI only when held", async () => {
    const mirrored: any[] = [];
    const { app, cookie, db, jobs } = setup([], false, Date.now(), { mirrorService: async (x: unknown) => { mirrored.push(x); } });
    db.media.push({ id: "m-own", handle: "nova", kind: "photo", key: "nova/photos/a.jpg" }, { id: "m-other", handle: "bob", kind: "photo", key: "bob/photos/b.jpg" });
    const add = (b: unknown) => app.request("http://x/api/app/items", post(b, cookie));
    expect((await app.request("http://x/api/app/items", post({ title: "Gold phone", price: 10 }))).status).toBe(401);
    expect((await add({ title: "G", price: 10 })).status).toBe(400);
    expect((await add({ title: "Gold phone", price: 0 })).status).toBe(400);
    expect((await add({ title: "Gold phone", price: 10, photoMediaId: "m-other" })).status).toBe(400);   // another store's photo
    const p = await add({ kind: "product", title: "Gold phone", price: 4999.5, description: "18k", options: ["Yellow", "Rose", ""], details: { stock: "made_to_order", shipping: "pickup", optionName: "Gold", evil: 1 } });
    expect(p.status).toBe(201);
    const pid = (await p.json()).id;
    expect(db.items[0]).toMatchObject({ kind: "product", priceUnits: "4999500000", options: ["Yellow", "Rose"], details: { stock: "made_to_order", shipping: "pickup", optionName: "Gold" }, active: true, held: null });
    expect(db.items[0].details.evil).toBeUndefined();
    const sv = await add({ kind: "service", title: "Security upgrade", price: 300, options: ["x", "y"], details: { mode: "buyer", deliveryDays: 3, question: "Which model?", priceFrom: true } });
    expect(db.items[1]).toMatchObject({ kind: "service", options: [], details: { mode: "buyer", deliveryDays: 3, question: "Which model?", priceFrom: true } });
    expect(jobs.filter((j) => j.task === "index_store").length).toBeGreaterThan(0);                  // the safety check runs
    expect((await add({ id: pid, kind: "product", title: "Gold phone 2", price: 10 })).status).toBe(200);
    expect((await add({ id: "i-nope", title: "Gold phone 2", price: 10 })).status).toBe(404);
    const vis = (id: string, active: boolean) => app.request(`http://x/api/app/items/${id}/visibility`, post({ active }, cookie));
    expect((await vis(pid, false)).status).toBe(200);
    expect(db.items[0].active).toBe(false);
    expect(mirrored.at(-1)).toMatchObject({ id: pid, active: false });                                // checkout stops selling it
    await add({ id: pid, kind: "product", title: "Gold phone 3", price: 10 });
    expect(db.items[0].active).toBe(false);                                                           // editing keeps it hidden
    await vis(pid, true);
    expect(db.items[0].active).toBe(true);
    const fix = (id: string) => app.request(`http://x/api/app/items/${id}/fix`, post({}, cookie));
    expect((await fix(pid)).status).toBe(409);                                                        // nothing to fix
    db.items[0].held = "mentions paying outside the store";
    expect((await fix(pid)).status).toBe(202);
    expect(jobs.at(-1)).toMatchObject({ task: "fix_item", payload: { handle: "nova", itemId: pid } });
    expect((await sv.json()).id).toBe("i-2");
  });

  it("store contact: email or phone with its app; Agent Market token from Settings", async () => {
    const connected: string[] = [];
    const { app, cookie, db } = setup([], false, Date.now(), { marketConnect: async (h: string, t: string) => { connected.push(`${h}:${t}`); } });
    const save = (b: unknown) => app.request("http://x/api/app/contact", post(b, cookie));
    expect((await save({})).status).toBe(400);
    expect((await save({ phone: "050 123 4567" })).status).toBe(400);                                 // needs the country code
    expect((await save({ email: "nope" })).status).toBe(400);
    expect((await save({ phone: "+971 50 123-45-67", app: "whatsapp" })).status).toBe(200);
    expect(db.settings.get("contactOf:nova")).toEqual({ phone: "+971501234567", app: "whatsapp" });
    expect((await save({ phone: "+971501234567", app: "pigeon", email: "Shop@Example.com" })).status).toBe(200);
    expect(db.settings.get("contactOf:nova")).toEqual({ phone: "+971501234567", app: "sms", email: "shop@example.com" });
    expect((await app.request("http://x/api/app/market", post({ token: "x" }, cookie))).status).toBe(400);
    const m = await app.request("http://x/api/app/market", post({ token: "aat_0123456789abcdef" }, cookie));
    expect(await m.json()).toMatchObject({ webhookUrl: "https://nearchant.com/market/webhook/nova", webhookSecret: expect.stringMatching(/^whsec_[0-9a-f]{32}$/) });
    expect(connected).toEqual(["nova:aat_0123456789abcdef"]);
  });

  it("post editor: a flagged draft can't be published until fixed; ask-AI, new picture and skip", async () => {
    const { createHash } = await import("node:crypto");
    const { app, cookie, db, jobs } = setup();
    const h = (x: string) => createHash("sha256").update(x).digest("hex");
    db.posts.push({ id: "f0", handle: "nova", status: "ready", caption: "Order in our private channel", imageMediaId: "m1",
      idea: { safety: { flagged: true, summary: "Sends buyers to a private channel", caption_hash: h("Order in our private channel"), image: "m1" } } });
    const sched = await app.request("http://x/api/app/posts/f0/schedule", post({}, cookie));
    expect(sched.status).toBe(409);
    expect(await sched.json()).toMatchObject({ code: "needs_change", error: expect.stringContaining("private channel") });
    const one = await (await app.request("http://x/api/app/posts/f0", { headers: { cookie } })).json();
    expect(one).toMatchObject({ status: "ready", needsChange: "Sends buyers to a private channel", safetyChecked: true });
    expect((await app.request("http://x/api/app/posts/f0/rewrite", post({ style: "fix" }, cookie))).status).toBe(202);
    expect(jobs.at(-1)).toMatchObject({ task: "rewrite_caption", payload: { postId: "f0", style: "fix" } });
    // A changed caption is no longer covered by the old verdict: it may be scheduled (and is checked again on publish).
    db.posts[0].caption = "See it in our store"; db.posts[0].idea.rewrite = { status: "ready" };
    expect((await app.request("http://x/api/app/posts/f0/schedule", post({}, cookie))).status).toBe(200);
    db.posts[0].status = "ready";
    expect((await app.request("http://x/api/app/posts/f0/rewrite", post({ style: "fix" }, cookie))).status).toBe(409);   // nothing to fix now
    expect((await app.request("http://x/api/app/posts/f0/rewrite", post({ style: "custom", instruction: "x" }, cookie))).status).toBe(400);
    expect((await app.request("http://x/api/app/posts/f0/rewrite", post({ style: "custom", instruction: "mention gift wrapping" }, cookie))).status).toBe(202);
    expect(jobs.at(-1)).toMatchObject({ task: "rewrite_caption", payload: { style: "custom", instruction: "mention gift wrapping" } });
    const q = db.quota;
    expect((await app.request("http://x/api/app/posts/f0/picture", post({ instruction: "black velvet" }, cookie))).status).toBe(202);
    expect(db.quota).toBe(q - 1);
    expect(jobs.at(-1)).toMatchObject({ task: "remake_picture", payload: { postId: "f0", instruction: "black velvet" } });
    expect((await app.request("http://x/api/app/posts/f0/picture", post({}, cookie))).status).toBe(202);                 // one at a time: no second charge
    expect(db.quota).toBe(q - 1);
    expect((await app.request("http://x/api/app/posts/f0/skip", post({}, cookie))).status).toBe(200);
    expect(db.posts[0].status).toBe("skipped");
    expect(db.signals.at(-1)).toMatchObject({ postId: "f0", kind: "passed" });
  });

  it("a video stuck 'in progress' for 15 min (cut off) can be started again", async () => {
    const at = 1_790_000_000_000;
    const { app, cookie, db, jobs } = setup([], true, at);
    db.posts.push({ id: "s0", handle: "nova", status: "ready", imageMediaId: "m1", idea: { video: { status: "rendering", startedAt: at - 16 * 60_000 } } });
    const before = db.quota;
    expect((await app.request("http://x/api/app/posts/s0/video", post({}, cookie))).status).toBe(202);
    expect(jobs.filter((j) => j.task === "make_video")).toHaveLength(1);
    expect(db.quota).toBe(before);                                   // new run charged, cut-off run refunded
    expect((jobs.at(-1)!.payload as { runId: string }).runId).toBe(db.posts.at(-1).idea.video.runId);
  });

  it("wallet: JSON only, no future-dated messages, re-linking revokes the old wallet", async () => {
    const { KeyPair } = await import("near-api-js");
    const { randomBytes } = await import("node:crypto");
    const { walletSign } = await import("./wallet-helper.js");
    const at = 1_790_000_000_000;
    const w1 = KeyPair.fromRandom("ed25519"), w2 = KeyPair.fromRandom("ed25519");
    const { app, cookie, db } = setup([w1.getPublicKey().toString(), w2.getPublicKey().toString()], false, at);
    const body = (kp: any, account: string, purpose: string, ts = at) => {
      const p = { message: `nearchant:wallet:${purpose}:${ts}`, nonce: randomBytes(32), recipient: "nearchant.com", callbackUrl: null } as any;
      return { accountId: account, publicKey: kp.getPublicKey().toString(), signature: walletSign(kp, p), message: p.message, nonce: Buffer.from(p.nonce).toString("base64"), recipient: p.recipient, callbackUrl: null };
    };
    const form = { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body(w1, "a.testnet", "signin")) };
    expect((await app.request("http://x/api/wallet/verify", form)).status).toBe(415);
    expect((await app.request("http://x/api/wallet/verify", post(body(w1, "a.testnet", "signin", at + 5 * 60_000)))).status).toBe(401);
    await app.request("http://x/api/wallet/verify", post(body(w1, "a.testnet", "link"), cookie));
    await app.request("http://x/api/wallet/verify", post(body(w2, "b.testnet", "link"), cookie));
    expect(db.settings.get("wallet:a.testnet")).toBeNull();
    expect((await app.request("http://x/api/wallet/verify", post(body(w1, "a.testnet", "signin")))).status).toBe(404);
    expect((await app.request("http://x/api/wallet/verify", post(body(w2, "b.testnet", "signin")))).status).toBe(200);
  });
});
