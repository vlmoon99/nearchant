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
    // A store with no place shows up too, after the ones that are there.
    const nowhere = await store(c, f, "gymnowhere", "Gym Nowhere", {}, "Whey protein", 1);
    const ny2 = (await f.feed({ vector: v(1), terms: ["protein"], country: "US", city: "New York" })).map((p) => p.id);
    expect(ny2.indexOf(nowhere)).toBeGreaterThan(ny2.indexOf(whey));

    // A budget: only posts whose item (or store) has something at that price.
    await c.upsertItem({ id: "i-cheap", handle: "gymny", title: "Whey 1 kg", priceUnits: "30000000" });
    await c.upsertItem({ id: "i-dear", handle: "gymworld", title: "Whey 5 kg", priceUnits: "90000000" });
    const cheap = (await f.feed({ terms: ["whey"], maxPriceUnits: 50_000_000n })).map((p) => p.handle);
    expect(cheap).toContain("gymny");
    expect(cheap).not.toContain("gymworld");

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

    // "Stores that sell protein and denim": per good, which stores sell it; more goods covered ranks first.
    await c.upsertBusiness({ handle: "bothny", name: "Both NY", description: "gym and denim" });
    const bothPost = await store(c, f, "bothny", "Both NY", { city: "New York", country: "US", ships: "local" }, "Whey and denim", 1);
    await f.putVector("store", "bothny", "bothny", "h2", v(2));
    const stores = await f.storesFor([{ name: "protein", vector: v(1) }, { name: "denim", vector: v(2) }], { country: "US", city: "New York" });
    expect(stores[0]).toMatchObject({ handle: "bothny", matched: 2 });
    expect(stores[0]!.goods.map((x) => x.match)).toEqual([true, true]);
    expect(stores.find((x) => x.handle === "denimny")!.goods.map((x) => x.match)).toEqual([false, true]);
    expect(stores.map((x) => x.handle)).not.toContain("gymla"); // local store in another city
    void bothPost;

    // A visitor from Ukraine sees the Kyiv store that ships worldwide first in the default feed.
    expect((await f.feed({ preferCountry: "UA" }))[0]!.handle).toBe("gymworld");

    // Following: a feed of followed stores, and they rank higher in "For you".
    expect(await f.follow(b.id, "gymla", true)).toBe(1);
    expect(await f.follows(b.id, "gymla")).toBe(true);
    expect((await f.feed({ buyerId: b.id, onlyFollowing: true })).map((p) => p.handle)).toEqual(["gymla"]);
    expect(await f.follow(b.id, "gymla", false)).toBe(0);

    // The Liked page and "More like this".
    expect((await f.feed({ buyerId: b.id, onlyLiked: true })).map((p) => p.id)).toEqual([denim]);
    const sim = await f.similar(whey);
    expect(sim.map((p) => p.id)).not.toContain(whey);
    expect(sim.map((p) => p.id)).toEqual(expect.arrayContaining([wheyWorld, wheyLA])); // same meaning, other stores
    expect(sim.map((p) => p.id)).not.toContain(denim);                                  // different meaning
    expect(ny.find((p) => p.id === wheyWorld)!.why).toBe("Ships worldwide");
    expect(ny.find((p) => p.id === whey)!.why).toBe("In New York");

    // Removal: gone from the feed, recorded against the store with its IPs, undone by a person.
    await f.logIp("store", "gymla", "203.0.113.7");
    const r = await f.removePost(wheyLA, { category: "scam", confidence: 0.92, summary: "fake brand", by: "ai", identity: { accounts: ["gymla.nearchant.testnet"], emails: ["la@example.com"] } });
    expect(r).toEqual({ handle: "gymla", count: 1 });
    // Removing the same post again (more reports, a retried job) does not count twice.
    expect(await f.removePost(wheyLA, { category: "scam", confidence: 0.92, summary: "again", by: "ai", identity: { accounts: [], emails: [] } })).toEqual({ handle: "gymla", count: 1 });
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).not.toContain(wheyLA);
    const [vi] = (await f.listViolators()).filter((x) => x.subjectId === "gymla");
    expect(vi).toMatchObject({ subjectKind: "store", count: 1, accounts: ["gymla.nearchant.testnet"], emails: ["la@example.com"], ips: ["203.0.113.7"] });
    await f.restorePost(wheyLA, "owner");
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).toContain(wheyLA);
    expect((await f.listViolators()).find((x) => x.subjectId === "gymla")!.violations[0]!.undone).toBe(true);
    expect((await f.listViolators()).find((x) => x.subjectId === "gymla")!.count).toBe(0); // restored → count updated

    // Who is who: a new account from the same IP or email is linked to the violator; blocked IPs are recognised.
    const fresh = await f.removePost(denim, { category: "spam", confidence: 0.9, summary: "x", by: "ai", identity: { accounts: ["denimny.nearchant.testnet"], emails: ["bad@example.com"] } });
    expect(fresh?.count).toBe(1);
    expect((await f.linkedViolators({ emails: ["bad@example.com"] })).map((v) => v.subjectId)).toEqual(["denimny"]);
    expect((await f.linkedViolators({ emails: ["bad@example.com"], except: { kind: "store", id: "denimny" } }))).toEqual([]);
    expect(await f.linkedViolators({ ips: ["192.0.2.1"] })).toEqual([]);
    await f.blockIps(["203.0.113.7"], true);
    expect(await f.isBlocked("203.0.113.7")).toBe(true);
    expect(await f.isBlocked("203.0.113.8")).toBe(false);
    await f.blockIps(["203.0.113.7"], false);
    expect(await f.isBlocked("203.0.113.7")).toBe(false);
    await f.restorePost(denim, "owner");

    // A suspended store disappears entirely.
    await f.suspendStore("gymworld", "3 removals");
    expect((await f.feed({ terms: ["whey"] })).map((p) => p.id)).not.toContain(wheyWorld);
    await f.suspendStore("gymworld", null);
  });

  it("search demand: what shoppers want, anonymously, and which searches showed a store", async () => {
    const f = new FeedStore(conn.db);
    await f.logSearch({ goods: ["whey protein"], city: "New York", country: "US", results: 2, handles: ["gymny", "gymworld"], src: "a" });
    await f.logSearch({ goods: ["whey protein"], city: null, country: null, results: 1, handles: ["gymny"], src: "b" });
    for (let i = 0; i < 5; i++) await f.logSearch({ goods: ["Whey Protein"], city: null, country: null, results: 1, handles: ["gymny"], src: "b" }); // repeats don't count
    await f.logSearch({ goods: [], city: null, country: null, results: 0, handles: [], src: "c" });                                              // nothing the planner understood: not logged
    await f.logSearch({ goods: ["kimchi"], city: "New York", country: "US", results: 0, handles: [], src: "a" });
    const d = await f.demand({ days: 30, country: "US" });
    expect(d[0]).toEqual({ goods: "whey protein", searches: 2, empty: 0 });
    expect(d.find((x) => x.goods === "kimchi")).toEqual({ goods: "kimchi", searches: 1, empty: 1 });
    expect(await f.searchesFor("gymny", 30)).toEqual({ count: 2, goods: ["whey protein"] });
    // Lists kept in settings grow atomically, newest first, capped.
    const c = new ContentStore(conn.db);
    await Promise.all(Array.from({ length: 12 }, (_, i) => c.prependSetting("list:test", { i }, 10)));
    const list = (await c.getSetting<{ i: number }[]>("list:test"))!;
    expect(list).toHaveLength(10);
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
