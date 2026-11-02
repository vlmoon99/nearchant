import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentStore, FeedStore } from "../src/index.js";
import { freshDb } from "./helpers.js";

let conn: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { conn = await freshDb(); });
afterAll(async () => { await conn?.drop(); });

/** A 1024-dim unit vector pointing mostly at `axis` (cosine similarity ≈ 1 with itself, ≈ 0 with other axes). */
const v = (axis: number, mix: [number, number] = [axis, 0]) => { const x = new Array(1024).fill(0); x[axis] = 1; x[mix[0]] += mix[1]; return x; };

async function store(c: ContentStore, f: FeedStore, handle: string, name: string, place: { city?: string; country?: string; ships?: string }, caption: string, axis: number) {
  await c.upsertBusiness({ handle, name, description: `${name} sells things` });
  await conn.db.execute(`update businesses set city = ${place.city ? `'${place.city}'` : "null"}, country = ${place.country ? `'${place.country}'` : "null"}, ships = ${place.ships ? `'${place.ships}'` : "null"} where handle = '${handle}'` as never);
  const { ids } = await c.createPosts(handle, [{}]);
  await c.updatePost(ids[0]!, { status: "published", caption, publishedAt: new Date(), idea: { publicImage: `${handle}/public/p.png` } });
  await f.putVector("post", ids[0]!, handle, "h", v(axis));
  return ids[0]!;
}

describe("FeedStore", () => {
  it("finds posts by meaning and words, filters by region, ranks likes, hides removed posts and suspended stores", async () => {
    const c = new ContentStore(conn.db), f = new FeedStore(conn.db);
    const whey = await store(c, f, "gymny", "Gym NY", { city: "New York", country: "US", ships: "local" }, "Whey isolate, 28 g protein", 1);
    const wheyLA = await store(c, f, "gymla", "Gym LA", { city: "Los Angeles", country: "US", ships: "local" }, "Whey for runners", 1);
    const wheyWorld = await store(c, f, "gymworld", "Gym World", { city: "Kyiv", country: "UA", ships: "world" }, "Creatine and whey", 1);
    const denim = await store(c, f, "denimny", "Denim NY", { city: "New York", country: "US", ships: "country" }, "Raw denim jacket", 2);

    // "protein in New York": the semantic match (axis 1) in New York, plus stores that ship there.
    const ny = await f.feed({ vector: v(1), terms: ["protein"], country: "US", city: "New York" });
    expect(ny.map((p) => p.id)).toContain(whey);
    expect(ny.map((p) => p.id)).toContain(wheyWorld);      // ships worldwide
    expect(ny.map((p) => p.id)).not.toContain(wheyLA);     // local store in another city
    expect(ny.map((p) => p.id)).not.toContain(denim);      // not relevant
    expect(ny[0]!.id).toBe(whey);                          // same city ranks first

    // Words alone (no embedding available) still find it.
    expect((await f.feed({ terms: ["denim"] })).map((p) => p.id)).toEqual([denim]);

    // Likes: counted, marked for the buyer, and "For you" leans to what the buyer liked.
    const b = await f.buyerByEmail("buyer@example.com");
    expect((await f.buyerByEmail("buyer@example.com")).id).toBe(b.id);
    expect(await f.like(b.id, denim, true)).toBe(1);
    expect(await f.like(b.id, denim, true)).toBe(1);       // once per buyer
    const forYou = await f.feed({ buyerId: b.id });
    expect(forYou[0]!.id).toBe(denim);
    expect(forYou[0]!.liked).toBe(true);

    // Removal: gone from the feed, recorded against the store with its IPs, undone by a person.
    await f.logIp("store", "gymla", "203.0.113.7");
    const r = await f.removePost(wheyLA, { category: "scam", confidence: 0.92, summary: "fake brand", by: "ai", identity: { accounts: ["gymla.nearchant.testnet"], emails: ["la@example.com"] } });
    expect(r).toEqual({ handle: "gymla", count: 1 });
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).not.toContain(wheyLA);
    const [vi] = (await f.listViolators()).filter((x) => x.subjectId === "gymla");
    expect(vi).toMatchObject({ subjectKind: "store", count: 1, accounts: ["gymla.nearchant.testnet"], emails: ["la@example.com"], ips: ["203.0.113.7"] });
    await f.restorePost(wheyLA, "owner");
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).toContain(wheyLA);
    expect((await f.listViolators()).find((x) => x.subjectId === "gymla")!.violations[0]!.undone).toBe(true);

    // A suspended store disappears entirely.
    await f.suspendStore("gymworld", "3 removals");
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).not.toContain(wheyWorld);
    await f.suspendStore("gymworld", null);
  });

  it("keeps reports with their decisions and counts recent ones per reporter", async () => {
    const f = new FeedStore(conn.db);
    const id = await f.addReport({ targetKind: "post", postId: "p-x", handle: "gymny", reporterIp: "198.51.100.2", reason: "scam", note: "fake" });
    expect(await f.recentReports({ ip: "198.51.100.2" })).toBe(1);
    await f.decideReport(id, "auto_kept", "ai", { violation: false });
    expect(await f.getReport(id)).toMatchObject({ status: "auto_kept", decidedBy: "ai", ai: { violation: false } });
    expect((await f.listReports({ status: ["open"] })).find((x) => x.id === id)).toBeUndefined();
    await f.log("owner", "report.keep", `report:${id}`);
    expect((await f.listLog())[0]).toMatchObject({ actor: "owner", action: "report.keep" });
  });
});
