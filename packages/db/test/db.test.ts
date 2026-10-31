import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Artifacts, Envelopes, Outbox, PgStore, Sealer } from "../src/index.js";
import { freshDb } from "./helpers.js";

let conn: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => { conn = await freshDb(); });
afterAll(async () => { await conn?.drop(); });

describe("PgStore", () => {
  it("stores services and orders, transitions only from the expected state", async () => {
    const s = new PgStore(conn.db);
    await s.upsertService({ id: "deck", handle: "alice", title: "Deck", description: "d", priceUnits: "5000000", deliveryHours: 1, active: true });
    await s.upsertService({ id: "deck", handle: "alice", title: "Deck v2", description: "d", priceUnits: "6000000", deliveryHours: 1, active: true });
    await s.upsertService({ id: "old", handle: "alice", title: "Old", description: "d", priceUnits: "1", deliveryHours: 1, active: false });
    const list = await s.listServices("alice");
    expect(list.map((x) => x.title)).toEqual(["Deck v2"]);
    expect(await s.getService("bob", "deck")).toBeNull();

    const now = new Date().toISOString();
    await s.createOrder({ orderId: "o1", handle: "alice", serviceId: "deck", amount: "6000000", brief: "b", buyerAccountId: null, state: "awaiting_payment", createdAt: now, updatedAt: now });
    await expect(s.createOrder({ orderId: "o1", handle: "alice", serviceId: "deck", amount: "1", brief: "b", buyerAccountId: null, state: "awaiting_payment", createdAt: now, updatedAt: now })).rejects.toThrow();
    expect(await s.transitionOrder("o1", "awaiting_payment", "paid")).toBe(true);
    expect(await s.transitionOrder("o1", "awaiting_payment", "paid")).toBe(false);
    expect((await s.getOrder("o1"))?.state).toBe("paid");
  });
});

describe("Artifacts and Envelopes", () => {
  it("keeps the first artifact write", async () => {
    const a = new Artifacts(conn.db);
    expect(await a.put("o1", "brief", { v: 1 })).toBe(true);
    expect(await a.put("o1", "brief", { v: 2 })).toBe(false);
    expect(await a.get("o1", "brief")).toEqual({ v: 1 });
    expect(Object.keys(await a.all("o1"))).toEqual(["brief"]);
  });

  it("tracks unsettled envelopes", async () => {
    const e = new Envelopes(conn.db);
    await e.add("o1", "brief", "alice.nearchant.testnet", { costUsd: 0.001 });
    await e.add("o1", "write", "alice.nearchant.testnet", { costUsd: 0.002 });
    const open = await e.unsettled();
    expect(open).toHaveLength(2);
    await e.markSettled(open.map((r) => r.id), "b1");
    expect(await e.unsettled()).toHaveLength(0);
  });
});

describe("Outbox", () => {
  it("is idempotent by key, sends once, retries failures with backoff", async () => {
    const o = new Outbox(conn.db);
    expect(await o.enqueue("deliver:o1", "chain.call", { m: "mark_delivered" })).toBe(true);
    expect(await o.enqueue("deliver:o1", "chain.call", { m: "again" })).toBe(false);
    await o.enqueue("post:o2", "telegram", { text: "hi" });

    let fail = true;
    const seen: string[] = [];
    const handler = async (kind: string, payload: any) => {
      seen.push(kind);
      if (kind === "telegram" && fail) throw new Error("telegram down");
      return { ok: payload };
    };
    expect(await o.drain(handler)).toBe(1);
    expect((await o.get("deliver:o1"))?.state).toBe("done");
    const failed = await o.get("post:o2");
    expect(failed?.state).toBe("pending");
    expect(failed?.lastError).toBe("telegram down");
    expect(failed!.nextAt.getTime()).toBeGreaterThan(Date.now());
    fail = false;
    expect(await o.drain(handler)).toBe(0); // not due yet
    expect(seen).toEqual(["chain.call", "telegram"]);
  });

  it("two drainers never send the same item", async () => {
    const o = new Outbox(conn.db);
    for (let i = 0; i < 10; i++) await o.enqueue(`k${i}`, "x", { i });
    const sent: number[] = [];
    const h = async (_k: string, p: any) => { sent.push(p.i); await new Promise((r) => setTimeout(r, 5)); };
    await Promise.all([o.drain(h), o.drain(h)]);
    expect(sent.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("Sealer", () => {
  it("round-trips and binds to its label", () => {
    const s = new Sealer("x".repeat(32));
    const sealed = s.seal("ed25519:secret", "alice/orders-key");
    expect(sealed).not.toContain("secret");
    expect(s.open(sealed, "alice/orders-key")).toBe("ed25519:secret");
    expect(() => s.open(sealed, "bob/orders-key")).toThrow();
    expect(() => new Sealer("short")).toThrow();
  });
});
