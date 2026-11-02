import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ContentStore, FeedStore } from "@nearchant/db";
import { mountModeration } from "../src/admin/moderation.js";

function setup() {
  const calls: string[] = [];
  const report = { id: 1, targetKind: "post", postId: "p1", handle: "shoes", reporterBuyerId: "b1", reporterIp: "203.0.113.9", reason: "counterfeit", note: "fake", status: "open", ai: null, decidedBy: null, decidedAt: null, createdAt: new Date() };
  const feed = {
    listReports: async () => [report], getReport: async () => report, removedPosts: async () => [], listViolators: async () => [], listLog: async () => [],
    removePost: async (id: string, v: { by: string }) => { calls.push(`remove ${id} by ${v.by}`); return { handle: "shoes", count: 1 }; },
    restorePost: async (id: string, by: string) => { calls.push(`restore ${id} by ${by}`); }, decideReport: async (id: number, s: string, by: string) => { calls.push(`report ${id} ${s} by ${by}`); },
    suspendStore: async (h: string, r: string | null) => { calls.push(`suspend ${h} ${r}`); }, recordViolation: async () => 1, getBuyer: async () => ({ id: "b1", email: "x@y.z", wallet: null }),
    banBuyer: async (id: string, r: string | null) => { calls.push(`ban ${id} ${r}`); }, log: async (who: string, what: string) => { calls.push(`log ${who} ${what}`); },
  } as unknown as FeedStore;
  const content = { getPost: async () => ({ id: "p1", handle: "shoes", caption: "1:1 replica", idea: {}, imageMediaId: null, removedAt: null }), getMedia: async () => null,
    getSetting: async () => null, getBusiness: async () => ({ handle: "shoes" }), listBusinesses: async () => [] } as unknown as ContentStore;
  const app = new Hono();
  mountModeration(app, { feed, content, mediaDir: "/tmp", password: "s3cret-pass", key: Buffer.alloc(32, 9), accountOf: (h) => `${h}.nearchant.testnet` });
  app.get("/", (c) => c.text("image lab"));
  return { app, calls };
}
const form = (body: string, cookie?: string) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body });

describe("admin moderation", () => {
  it("everything needs a signed-in moderator, the image lab too; a wrong password is refused and then locked", async () => {
    const { app } = setup();
    expect((await app.request("http://x/")).headers.get("location")).toBe("/mod/login");
    expect((await app.request("http://x/mod/reports")).status).toBe(302);
    expect((await app.request("http://x/mod/report/1/remove", form(""))).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await app.request("http://x/mod/login", form("name=Eve&password=nope"))).status).toBe(401);
    expect((await app.request("http://x/mod/login", form("name=Vlad&password=s3cret-pass"))).status).toBe(429); // locked for a minute
  });

  it("signs in with a name, shows the report queue, logs every decision with the moderator's name", async () => {
    const { app, calls } = setup();
    const r = await app.request("http://x/mod/login", form("name=Vlad&password=s3cret-pass"));
    expect(r.status).toBe(303);
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=Strict/);
    expect(await (await app.request("http://x/", { headers: { cookie } })).text()).toBe("image lab");
    const page = await (await app.request("http://x/mod/reports", { headers: { cookie } })).text();
    expect(page).toContain("counterfeit");
    expect(page).toContain("203.0.113.9");
    await app.request("http://x/mod/report/1/remove", form("", cookie));
    await app.request("http://x/mod/report/1/restore", form("", cookie));
    await app.request("http://x/mod/store/shoes/suspend", form("", cookie));
    await app.request("http://x/mod/buyer/b1/ban", form("", cookie));
    expect(calls).toEqual(expect.arrayContaining(["remove p1 by Vlad", "report 1 removed by Vlad", "restore p1 by Vlad", "report 1 kept by Vlad", "suspend shoes suspended by Vlad", "ban b1 banned by Vlad", "log Vlad post.remove", "log Vlad store.suspend"]));
    // A forged cookie is not a session.
    expect((await app.request("http://x/mod/reports", { headers: { cookie: "nc_admin=Mallory%3A9999999999999.AAAA" } })).status).toBe(302);
  });
});
