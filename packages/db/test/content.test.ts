import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentStore, QuotaExceeded } from "../src/index.js";
import { freshDb } from "./helpers.js";

let conn: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { conn = await freshDb(); });
afterAll(async () => { await conn?.drop(); });

describe("ContentStore", () => {
  it("keeps a business, its profile and the facts found while analysing", async () => {
    const c = new ContentStore(conn.db);
    await c.upsertBusiness({ handle: "nova", name: "Nova Wear", kind: "products", description: "Relaxed clothes", links: ["instagram.com/novawear"] });
    expect((await c.getProfile("nova"))?.status).toBe("none");
    await c.setProfile("nova", { status: "analyzing" });
    await c.addFact("nova", { title: "Found 14 products", detail: "denim, knitwear" });
    await c.addFact("nova", { title: "Your style", detail: "warm" });
    const p = await c.getProfile("nova");
    expect(p?.status).toBe("analyzing");
    expect((p?.facts as unknown[]).length).toBe(2);
    await c.completeOnboarding("nova");
    expect((await c.getBusiness("nova"))?.onboardedAt).toBeTruthy();
  });

  it("reserves posts within the plan and refunds failed ones", async () => {
    const c = new ContentStore(conn.db);
    await c.upsertBusiness({ handle: "q1", name: "Q" });
    const { ids } = await c.createPosts("q1", Array.from({ length: 10 }, () => ({ idea: { angle: "x" } })));
    expect((await c.usage("q1")).posts).toBe(10);
    await expect(c.createPosts("q1", [{}, {}, {}])).rejects.toBeInstanceOf(QuotaExceeded);
    expect((await c.usage("q1")).posts).toBe(10); // nothing reserved by the failed call
    await c.failPost(ids[0]!, "render failed");
    await c.failPost(ids[0]!, "again");          // second failure refunds nothing more
    expect((await c.usage("q1")).posts).toBe(9);
    await c.createPosts("q1", [{}, {}, {}]);      // fits again after the refund
    expect((await c.usage("q1")).posts).toBe(12);
  });

  it("chooses some options of a batch, passes the rest, and records signals", async () => {
    const c = new ContentStore(conn.db);
    await c.upsertBusiness({ handle: "ch", name: "C" });
    const { batchId, ids } = await c.createPosts("ch", [{ idea: { a: 1 } }, { idea: { a: 2 } }, { idea: { a: 3 } }]);
    await c.choosePosts("ch", batchId, [ids[0]!, ids[2]!]);
    const visible = await c.listPosts("ch");
    expect(visible.map((p) => p.id).sort()).toEqual([ids[0], ids[2]].sort());
    const sig = await c.signalsSince("ch");
    expect(sig.map((x) => x.kind).sort()).toEqual(["chose", "chose", "passed"]);
  });

  it("replaces open opportunities but keeps chosen ones", async () => {
    const c = new ContentStore(conn.db);
    const first = await c.replaceOpportunities("op", [{ kind: "trend", title: "Linen", why: "w", estimateUnits: "180000000" }, { kind: "price", title: "49", why: "w", estimateUnits: "90000000" }]);
    await c.chooseOpportunities("op", [first[0]!]);
    await c.replaceOpportunities("op", [{ kind: "upsell", title: "Bundle", why: "w", estimateUnits: "210000000" }]);
    expect((await c.listOpportunities("op")).map((o) => o.title).sort()).toEqual(["Bundle", "Linen"]);
  });

  it("counts analytics events per day and kind", async () => {
    const c = new ContentStore(conn.db);
    for (const k of ["view", "view", "click", "sale"]) await c.addEvent({ handle: "an", kind: k, source: "telegram" });
    const rows = await c.eventCounts("an", 7);
    expect(rows.find((r) => r.kind === "view")?.n).toBe(2);
    expect(rows.find((r) => r.kind === "sale")?.n).toBe(1);
  });
});

describe("sales and settings", () => {
  it("sums sale amounts and keeps settings", async () => {
    const c = new ContentStore(conn.db);
    await c.addEvent({ handle: "sl", kind: "sale", data: { amount: "45000000" } });
    await c.addEvent({ handle: "sl", kind: "sale", data: { amount: "22000000" } });
    await c.addEvent({ handle: "sl", kind: "view" });
    expect(await c.salesSince("sl", 7)).toEqual({ count: 2, units: 67000000n });
    await c.setSetting("celebrated:sl", true);
    expect(await c.getSetting("celebrated:sl")).toBe(true);
  });
});

describe("migrations", () => {
  it("two processes migrating a fresh database at once both succeed (advisory lock)", async () => {
    const { connect, runMigrations } = await import("../src/index.js");
    const postgres = (await import("postgres")).default;
    const admin = process.env.TEST_DATABASE_URL ?? "postgres://nearchant:nearchant-dev@127.0.0.1:55432/nearchant";
    const name = `t_race_${Date.now().toString(36)}`;
    const a0 = postgres(admin, { max: 1, onnotice: () => {} });
    await a0.unsafe(`create database ${name}`);
    const url = admin.replace(/\/[^/]+$/, `/${name}`);
    const p1 = connect(url, { max: 2 }), p2 = connect(url, { max: 2 });
    try {
      await Promise.all([runMigrations(p1.db, p1.sql), runMigrations(p2.db, p2.sql)]);
      const [{ n }] = await p1.sql`select count(*)::int as n from information_schema.tables where table_name = 'posts'`;
      expect(n).toBe(1);
    } finally {
      await p1.close(); await p2.close();
      await a0.unsafe(`drop database ${name}`); await a0.end();
    }
  });
});
