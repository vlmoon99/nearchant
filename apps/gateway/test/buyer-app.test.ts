import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import type { FeedStore } from "@nearchant/db";
import { feedFor, mountBuyerApp } from "../src/buyer-app.js";
import { signSession } from "../src/seller-app.js";
import { walletSign } from "./wallet-helper.js";

function setup() {
  const buyers = new Map<string, { id: string; email: string | null; wallet: string | null; status: string }>();
  const likes = new Set<string>(), reports: Record<string, unknown>[] = [], jobs: [string, Record<string, unknown>][] = [], ips: string[] = [], mails: { to: string; text: string }[] = [];
  const settings = new Map<string, unknown>();
  const find = (k: "email" | "wallet", v: string) => [...buyers.values()].find((b) => b[k] === v);
  const make = (k: "email" | "wallet", v: string) => find(k, v) ?? (buyers.set(`b${buyers.size}`, { id: `b${buyers.size}`, email: k === "email" ? v : null, wallet: k === "wallet" ? v : null, status: "active" }), find(k, v)!);
  const feed = {
    buyerByEmail: async (e: string) => make("email", e), buyerByWallet: async (w: string) => make("wallet", w), getBuyer: async (id: string) => buyers.get(id) ?? null, touchBuyer: async () => {},
    logIp: async (_k: string, _id: string, ip: string) => { ips.push(ip); },
    like: async (b: string, p: string, on: boolean) => { if (on) likes.add(`${b}:${p}`); else likes.delete(`${b}:${p}`); return [...likes].filter((x) => x.endsWith(`:${p}`)).length; },
    likedBy: async (b: string, ids: string[]) => new Set(ids.filter((p) => likes.has(`${b}:${p}`))),
    addReport: async (r: Record<string, unknown>) => { reports.push(r); return reports.length; }, recentReports: async () => 0,
    reportedBefore: async (b: string, t: { postId?: string | null; handle: string }) => reports.some((r) => r.reporterBuyerId === b && (t.postId ? r.postId === t.postId : r.handle === t.handle && r.targetKind === "store")),
    feed: async (q: Record<string, unknown>) => [{ id: "p1", q }],
  } as unknown as FeedStore;
  const app = new Hono();
  const owner = KeyPair.fromRandom("ed25519");
  mountBuyerApp(app, {
    feed, isOwnerKey: async (a, pk) => a === "alice.testnet" && pk === owner.getPublicKey().toString(),
    content: { getPost: async (id) => (id === "p1" ? { id, handle: "nova", status: "published", removedAt: null } : id === "gone" ? { id, handle: "nova", status: "published", removedAt: new Date() } : null),
      getSetting: async <T,>(k: string) => (settings.get(k) as T) ?? null, setSetting: async (k, v) => { settings.set(k, v); }, getBusiness: async (h) => (h === "nova" ? { handle: h, name: "Nova Wear" } : null),
      prependSetting: async (k, v) => { settings.set(k, [v, ...((settings.get(k) as unknown[]) ?? [])]); } },
    sellerKey: Buffer.alloc(32, 9), orderOf: async (id) => (id.startsWith("o-") ? { handle: "nova" } : null),
    enqueue: async (t, p) => { jobs.push([t, p]); }, key: Buffer.alloc(32, 3), secureCookies: false, walletRecipient: "nearchant.com", publicUrl: "https://nearchant.com",
    mail: async (m) => { mails.push(m); },
  });
  return { app, buyers, likes, reports, jobs, ips, mails, owner, settings };
}
const post = (body: unknown, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0]!;

describe("buyers", () => {
  it("signs in with an email link (button page, once) and goes back to the page they came from", async () => {
    const t = setup();
    expect((await t.app.request("http://x/api/buyer/email", post({ email: "Buyer@Example.com", back: "/h/nova/p/p1" }))).status).toBe(200);
    const link = /https:\/\/nearchant\.com(\/auth\/buyer\?t=[\w.-]+)/.exec(t.mails[0]!.text)![1]!;
    expect(await (await t.app.request(`http://x${link}`)).text()).toContain('action="/auth/buyer"');
    const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${new URL(`http://x${link}`).searchParams.get("t")}` };
    const r = await t.app.request("http://x/auth/buyer", form);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/h/nova/p/p1");
    expect(r.headers.get("set-cookie")).toMatch(/nc_buyer=b0\./);
    expect((await t.app.request("http://x/auth/buyer", form)).status).toBe(400); // once
    const me = await t.app.request("http://x/api/buyer/me", { headers: { cookie: cookieOf(r) } });
    expect(await me.json()).toMatchObject({ email: "buyer@example.com" });
    // An open redirect is not possible.
    await t.app.request("http://x/api/buyer/email", post({ email: "b2@example.com", back: "//evil.example" }));
    const link2 = /(\/auth\/buyer\?t=[\w.-]+)/.exec(t.mails[1]!.text)![1]!;
    const r2 = await t.app.request("http://x/auth/buyer", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${new URL(`http://x${link2}`).searchParams.get("t")}` });
    expect(r2.headers.get("location")).toBe("/feed");
  });

  it("signs in with any NEAR wallet (NEP-413), refusing other sites, reused nonces and keys that are not the account's", async () => {
    const t = setup();
    const msg = (nonce = randomBytes(32), recipient = "nearchant.com", kp = t.owner) => {
      const message = `nearchant:buyer:signin:${Date.now()}`;
      return { accountId: "alice.testnet", publicKey: kp.getPublicKey().toString(), signature: walletSign(kp, { message, nonce, recipient, callbackUrl: null }), message, nonce: nonce.toString("base64"), recipient };
    };
    const ok = msg();
    const r = await t.app.request("http://x/api/buyer/wallet", post(ok));
    expect(await r.json()).toMatchObject({ wallet: "alice.testnet" });
    expect((await t.app.request("http://x/api/buyer/wallet", post(ok))).status).toBe(401);            // nonce reused
    expect((await t.app.request("http://x/api/buyer/wallet", post(msg(undefined, "evil.example")))).status).toBe(401);
    expect((await t.app.request("http://x/api/buyer/wallet", post(msg(undefined, undefined, KeyPair.fromRandom("ed25519"))))).status).toBe(403);
    expect((await t.app.request("http://x/api/buyer/wallet", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(msg()) })).status).toBe(415);
  });

  it("likes and reports need a signed-in buyer; reports go to the moderator; banned buyers can't", async () => {
    const t = setup();
    expect((await t.app.request("http://x/api/feed/like", post({ postId: "p1" }))).status).toBe(401);
    const s = await t.app.request("http://x/api/buyer/wallet", post((() => { const n = randomBytes(32), message = `nearchant:buyer:signin:${Date.now()}`; return { accountId: "alice.testnet", publicKey: t.owner.getPublicKey().toString(), signature: walletSign(t.owner, { message, nonce: n, recipient: "nearchant.com", callbackUrl: null }), message, nonce: n.toString("base64"), recipient: "nearchant.com" }; })()));
    const cookie = cookieOf(s);
    expect(await (await t.app.request("http://x/api/feed/like", post({ postId: "p1" }, cookie))).json()).toEqual({ likes: 1, liked: true });
    expect((await t.app.request("http://x/api/feed/like", post({ postId: "gone" }, cookie))).status).toBe(404);
    expect(await (await t.app.request("http://x/api/feed/liked?ids=p1,p2", { headers: { cookie } })).json()).toEqual({ liked: ["p1"] });
    expect((await t.app.request("http://x/api/report", post({ postId: "p1", reason: "nonsense" }, cookie))).status).toBe(400);
    expect(await (await t.app.request("http://x/api/report", post({ postId: "p1", reason: "counterfeit", note: "fake logo" }, cookie))).json()).toEqual({ report: 1 });
    expect(t.jobs[0]).toEqual(["moderate_post", { postId: "p1", reportId: 1 }]);
    await t.app.request("http://x/api/report", post({ handle: "nova", reason: "scam", note: "never shipped" }, cookie));
    expect(t.jobs[1]).toEqual(["moderate_store", { handle: "nova", reportId: 2 }]);
    expect((await t.app.request("http://x/api/report", post({ postId: "p1", reason: "scam" }, cookie))).status).toBe(409);   // one report per post
    expect((await t.app.request("http://x/api/report", post({ postId: "gone", reason: "scam" }, cookie))).status).toBe(409); // removed already
    expect(t.reports[0]).toMatchObject({ targetKind: "post", handle: "nova", reporterBuyerId: "b0", reason: "counterfeit" });
    t.buyers.get("b0")!.status = "banned";
    expect((await t.app.request("http://x/api/feed/like", post({ postId: "p1" }, cookie))).status).toBe(401);
  });

  it("search: the AI plan and vector go to the feed query; without AI it searches words", async () => {
    let seen: Record<string, unknown> = {};
    const feed = { feed: async (q: Record<string, unknown>) => { seen = q; return []; } } as unknown as FeedStore;
    const r = await feedFor({ feed, understand: async () => ({ summary: "Protein in New York", terms: ["protein", "whey"], city: "New York", country: "US", vector: [0.1, 0.2] }) }, "protein nyc", "b1");
    expect(seen).toMatchObject({ terms: ["protein", "whey"], city: "New York", country: "US", vector: [0.1, 0.2], buyerId: "b1" });
    await feedFor({ feed, understand: async () => ({ summary: "Whey under $50", terms: ["whey"], city: null, country: null, vector: null, maxPriceUnits: "50000000" }) }, "whey under $50", null);
    expect(seen).toMatchObject({ maxPriceUnits: 50_000_000n });
    expect(r.intent).toMatchObject({ summary: "Protein in New York", vector: null }); // the vector is not sent to the page
    // "Stores that sell 1, 2": each good's vector goes to the store matcher; vectors never reach the page.
    let matched: unknown = null;
    const feed2 = { feed: async () => [], storesFor: async (g: unknown) => { matched = g; return [{ handle: "gym", matched: 2 }]; } } as unknown as FeedStore;
    const r2 = await feedFor({ feed: feed2, understand: async () => ({ summary: "s", terms: ["whey"], city: null, country: null, vector: [1], goodVectors: [{ name: "protein", vector: [0.1] }, { name: "creatine", vector: [0.2] }] }) }, "protein and creatine", null);
    expect(matched).toEqual([{ name: "protein", vector: [0.1] }, { name: "creatine", vector: [0.2] }]);
    expect(r2.stores).toEqual([{ handle: "gym", matched: 2 }]);
    expect(JSON.stringify(r2.intent)).not.toContain("0.1");
    // The City box reaches the planner, so a city alone still finds its country.
    const asked: string[] = [];
    await feedFor({ feed, understand: async (q) => { asked.push(q); return { summary: q, terms: ["whey"], city: "Austin", country: "US", vector: null }; } }, "whey", null, 0, { city: "Austin" });
    expect(asked).toEqual(["whey in Austin"]);
    expect(seen).toMatchObject({ city: "Austin", country: "US" });
    await feedFor({ feed, understand: async (q) => { asked.push(q); return { summary: "x", terms: [], city: "Austin", country: "US", vector: null }; } }, "", null, 0, { city: "Austin" });
    expect(seen).toMatchObject({ terms: [], city: "Austin", country: "US", vector: null });
    await feedFor({ feed, understand: async () => { throw new Error("model down"); } }, "Denim jacket", null, 0, { city: "Austin", country: "us" });
    expect(seen).toMatchObject({ terms: ["denim", "jacket"], city: "Austin", country: "US", vector: null });
  });
});

describe("shopping ↔ selling", () => {
  const walletIn = async (t: ReturnType<typeof setup>) => {
    const nonce = randomBytes(32), message = `nearchant:buyer:signin:${Date.now()}`;
    const r = await t.app.request("http://x/api/buyer/wallet", post({ accountId: "alice.testnet", publicKey: t.owner.getPublicKey().toString(), signature: walletSign(t.owner, { message, nonce, recipient: "nearchant.com", callbackUrl: null }), message, nonce: nonce.toString("base64"), recipient: "nearchant.com" }));
    return cookieOf(r);
  };
  it("/api/me tells both roles of this browser, never 401", async () => {
    const t = setup();
    expect(await (await t.app.request("http://x/api/me")).json()).toEqual({ buyer: null, store: null });
    const buyer = await walletIn(t);
    const seller = `nc_session=${signSession(Buffer.alloc(32, 9), "nova", Date.now() + 60_000)}`;
    expect(await (await t.app.request("http://x/api/me", { headers: { cookie: `${buyer}; ${seller}` } })).json()).toEqual({ buyer: { id: "b0", email: null, wallet: "alice.testnet" }, store: { handle: "nova", name: "Nova Wear" } });
    // A seller cookie signed with another key is not a store.
    const forged = `nc_session=${signSession(Buffer.alloc(32, 1), "nova", Date.now() + 60_000)}`;
    expect(await (await t.app.request("http://x/api/me", { headers: { cookie: forged } })).json()).toEqual({ buyer: null, store: null });
  });
  it("orders paid before signing in join the account once; someone else's stay theirs", async () => {
    const t = setup();
    expect((await t.app.request("http://x/api/buyer/claim-orders", post({ orders: [{ orderId: "o-1" }] }))).status).toBe(401);
    const cookie = await walletIn(t);
    t.settings.set("orderBuyer:o-taken", "b9");
    const r = await t.app.request("http://x/api/buyer/claim-orders", post({ orders: [{ orderId: "o-1" }, { orderId: "o-taken" }, { orderId: "nope" }, { orderId: "o-1" }, { orderId: "../x" }] }, cookie));
    expect(await r.json()).toEqual({ claimed: 1 });
    expect(t.settings.get("orderBuyer:o-1")).toBe("b0");
    expect(t.settings.get("orderBuyer:o-taken")).toBe("b9");
    expect((t.settings.get("buyerOrders:b0") as { orderId: string; handle: string }[]).map((o) => [o.orderId, o.handle])).toEqual([["o-1", "nova"]]);
    expect(await (await t.app.request("http://x/api/buyer/claim-orders", post({ orders: [{ orderId: "o-1" }] }, cookie))).json()).toEqual({ claimed: 0 });
  });
});
