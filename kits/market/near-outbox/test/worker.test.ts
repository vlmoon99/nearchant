import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox } from "../src/index.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("concurrent workers", () => {
  it("never hand the same item to two workers", async () => {
    const store = new MemoryStore(), ob = new Outbox(store);
    for (let i = 0; i < 50; i++) await ob.enqueue(`k${i}`, "x", i);
    const runs = new Map<number, number>();
    const handlers = { x: async (p: number) => { await tick(Math.random() * 3); runs.set(p, (runs.get(p) ?? 0) + 1); } };
    const results = await Promise.all(Array.from({ length: 5 }, () => ob.drain({ handlers, limit: 100 })));
    expect(results.reduce((a, r) => a + r.sent, 0)).toBe(50);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect(runs.size).toBe(50);
    expect(results.filter((r) => r.sent > 0).length).toBeGreaterThan(1); // the work was actually shared
  });
});

describe("runWorker", () => {
  it("picks up items queued later and stops on abort", async () => {
    const ob = new Outbox(new MemoryStore());
    const done: string[] = [];
    const ac = new AbortController();
    const running = ob.runWorker({ handlers: { x: async (p: string) => { done.push(p); } }, pollMs: 5, signal: ac.signal });
    await ob.enqueue("a", "x", "a");
    await tick(30);
    await ob.enqueue("b", "x", "b");
    await tick(30);
    ac.abort();
    await running;
    expect(done).toEqual(["a", "b"]);
  });

  it("retries a flaky handler until it works", async () => {
    const ob = new Outbox(new MemoryStore());
    let calls = 0;
    const ac = new AbortController();
    const running = ob.runWorker({ handlers: { x: async () => { if (++calls < 3) throw new Error("flaky"); ac.abort(); } }, pollMs: 2, backoff: () => 5, signal: ac.signal });
    await ob.enqueue("k", "x", {});
    await running;
    expect(calls).toBe(3);
    expect(await ob.get("k")).toMatchObject({ state: "done", attempts: 3 });
  });

  it("keeps running when the store throws, and logs it", async () => {
    const store = new MemoryStore();
    let broken = 2;
    const orig = store.claim.bind(store);
    store.claim = async (...a) => { if (broken-- > 0) throw new Error("connection refused"); return orig(...a); };
    const ob = new Outbox(store);
    const logs: string[] = [];
    const ac = new AbortController();
    await ob.enqueue("k", "x", {});
    const running = ob.runWorker({ handlers: { x: async () => { ac.abort(); } }, pollMs: 2, signal: ac.signal, log: (l) => logs.push(l) });
    await running;
    expect(logs.filter((l) => l.includes("connection refused"))).toHaveLength(2);
    expect((await ob.get("k"))!.state).toBe("done");
  });

  it("returns at once when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await new Outbox(new MemoryStore()).runWorker({ handlers: {}, signal: ac.signal, pollMs: 60_000 });
  });
});
