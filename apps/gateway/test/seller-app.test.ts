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
  const db = { business: new Map<string, any>(), profile: new Map<string, any>(), media: [] as any[], posts: [] as any[], signals: [] as any[], quota: 12 };
  const c: Partial<SellerContent> = {
    upsertBusiness: async (b) => { db.business.set(b.handle, b); if (!db.profile.has(b.handle)) db.profile.set(b.handle, { status: "none", facts: [] }); },
    getBusiness: async (h) => db.business.get(h) ?? null,
    getProfile: async (h) => db.profile.get(h) ?? null,
    setProfile: async (h, p) => { db.profile.set(h, { ...(db.profile.get(h) ?? {}), ...p }); },
    addMedia: async (m) => { const id = `m${db.media.length}`; db.media.push({ id, ...m }); return id; },
    listMedia: async (h, k) => db.media.filter((m) => m.handle === h && (!k || m.kind === k)),
    usage: async () => ({ posts: 12 - db.quota, images: 0 }),
    createPosts: async (h, ideas) => { if (ideas.length > db.quota) throw new QuotaExceeded("posts", 12); db.quota -= ideas.length; const ids = ideas.map((_, i) => `p${db.posts.length + i}`); ids.forEach((id) => db.posts.push({ id, handle: h, status: "ready" })); return { batchId: "b1", ids }; },
    getPost: async (id) => db.posts.find((p) => p.id === id) ?? null,
    updatePost: async (id, p) => { Object.assign(db.posts.find((x) => x.id === id), p); },
    addSignal: async (h, postId, kind) => { db.signals.push({ h, postId, kind }); },
    reserve: async (_h, _p, images) => { if (images > db.quota) throw new QuotaExceeded("images", 12); db.quota -= images; },
  };
  return { c: c as SellerContent, db };
}

function setup(ownerKeys: string[] = [], videoEnabled = false) {
  const app = new Hono();
  const { c, db } = fakeContent();
  const jobs: { task: string; payload: unknown }[] = [];
  const mediaDir = mkdtempSync(join(tmpdir(), "nc-media-"));
  const key = Buffer.alloc(32, 7);
  mountSellerApp(app, {
    content: c, handles: { get: async (h) => (h === "nova" ? nova : null) }, isOwnerKey: async (_a, pk) => ownerKeys.includes(pk),
    enqueue: async (task, payload) => { jobs.push({ task, payload }); }, mediaDir, sessionKey: key, secureCookies: false, decimals: 6, videoEnabled,
  });
  const cookie = `nc_session=${signSession(key, "nova", Date.now() + 60_000)}`;
  return { app, db, jobs, mediaDir, cookie, key };
}

const post = (body: unknown, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

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
    expect(db.posts[0].idea).toEqual({ angle: "a", video: { status: "writing" } });
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
});
