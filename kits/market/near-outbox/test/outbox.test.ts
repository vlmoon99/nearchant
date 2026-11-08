import { describe, expect, it } from "vitest";
import { MemoryStore, Outbox, exponentialBackoff, type Handlers } from "../src/index.js";

/** A clock the test moves by hand. */
const clock = (start = Date.parse("2026-11-08T12:00:00Z")) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};
const setup = () => {
  const c = clock(), store = new MemoryStore();
  return { c, store, ob: new Outbox(store, { now: c.now }) };
};
const fixed = (ms: number) => () => ms;

describe("enqueue", () => {
  it("is idempotent by key", async () => {
    const { ob, store } = setup();
    expect(await ob.enqueue("deliver:o1", "deliver", { orderId: "o1" })).toBe(true);
    expect(await ob.enqueue("deliver:o1", "deliver", { orderId: "DIFFERENT" })).toBe(false);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.payload).toEqual({ orderId: "o1" });
  });

  it("still refuses the key after the item is done (it never runs twice)", async () => {
    const { ob } = setup();
    let runs = 0;
    await ob.enqueue("k", "x", {});
    await ob.drain({ handlers: { x: async () => { runs++; } } });
    expect(await ob.enqueue("k", "x", {})).toBe(false);
    await ob.drain({ handlers: { x: async () => { runs++; } } });
    expect(runs).toBe(1);
  });

  it("refuses an empty key", () => expect(() => setup().ob.enqueue("", "x", {})).toThrow(/empty/));
});

describe("drain", () => {
  it("runs the handler for the kind with the payload and records the result", async () => {
    const { ob } = setup();
    await ob.enqueue("k", "item.ship", { orderId: "o1" });
    const seen: unknown[] = [];
    const r = await ob.drain({ handlers: { "item.ship": async (p, ctx) => { seen.push(p, ctx.key, ctx.attempt); return { tx: "abc" }; } } });
    expect(r).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(seen).toEqual([{ orderId: "o1" }, "k", 1]);
    expect(await ob.get("k")).toMatchObject({ state: "done", attempts: 1, lastError: null, result: { tx: "abc" } });
  });

  it("processes items oldest first", async () => {
    const { ob } = setup();
    for (const k of ["a", "b", "c"]) await ob.enqueue(k, "x", k);
    const order: unknown[] = [];
    await ob.drain({ handlers: { x: async (p) => { order.push(p); } } });
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("retries with backoff, counted from the failure, and records the error", async () => {
    const { ob, c } = setup();
    await ob.enqueue("k", "x", {});
    let calls = 0;
    const handlers: Handlers = { x: async () => { calls++; if (calls < 3) throw new Error(`NEAR said no #${calls}`); return "ok"; } };
    const backoff = exponentialBackoff({ baseMs: 1000, jitter: 0 });

    expect(await ob.drain({ handlers, backoff })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(await ob.get("k")).toMatchObject({ state: "pending", attempts: 1, lastError: "NEAR said no #1" });
    expect((await ob.get("k"))!.nextAt.getTime()).toBe(c.now() + 1000);

    c.advance(999);
    expect(await ob.drain({ handlers, backoff })).toEqual({ sent: 0, retrying: 0, failed: 0 }); // not due yet
    c.advance(1);
    expect(await ob.drain({ handlers, backoff })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect((await ob.get("k"))!.nextAt.getTime()).toBe(c.now() + 2000); // doubled

    c.advance(1999);
    expect((await ob.drain({ handlers, backoff })).retrying).toBe(0);
    c.advance(1);
    expect(await ob.drain({ handlers, backoff })).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(await ob.get("k")).toMatchObject({ state: "done", attempts: 3, lastError: null, result: "ok" });
    expect(calls).toBe(3);
  });

  it("marks the item failed after maxAttempts and stops retrying", async () => {
    const { ob, c } = setup();
    await ob.enqueue("k", "x", {});
    let calls = 0;
    const o = { handlers: { x: async () => { calls++; throw new Error("Smart contract panicked: Only the seller"); } }, maxAttempts: 3, backoff: fixed(10) };
    for (let i = 0; i < 10; i++) { await ob.drain(o); c.advance(10); }
    expect(calls).toBe(3);
    expect(await ob.get("k")).toMatchObject({ state: "failed", attempts: 3, lastError: "Smart contract panicked: Only the seller" });
  });

  it("treats a missing handler as a failure (a newer worker may have it)", async () => {
    const { ob } = setup();
    await ob.enqueue("k", "unknown.kind", {});
    expect(await ob.drain({ handlers: {}, backoff: fixed(5) })).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect((await ob.get("k"))!.lastError).toMatch(/no handler for outbox kind "unknown.kind"/);
    await ob.enqueue("k2", "toString", {}); // not a prototype method
    await ob.drain({ handlers: {}, backoff: fixed(5) });
    expect((await ob.get("k2"))!.lastError).toMatch(/no handler/);
  });

  it("records thrown non-errors and cuts long messages", async () => {
    const { ob } = setup();
    await ob.enqueue("a", "x", {});
    await ob.enqueue("b", "y", {});
    await ob.drain({ handlers: { x: async () => { throw "plain string"; }, y: async () => { throw new Error("e".repeat(5000)); } }, backoff: fixed(5) });
    expect((await ob.get("a"))!.lastError).toBe("plain string");
    expect((await ob.get("b"))!.lastError).toHaveLength(2000);
  });

  it("times out a hanging handler, aborts its signal and retries later", async () => {
    const { ob } = setup();
    await ob.enqueue("k", "x", {});
    let aborted = false;
    const r = await ob.drain({ handlers: { x: (_p, ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => { aborted = true; }); }) }, timeoutMs: 20, backoff: fixed(5) });
    expect(r.retrying).toBe(1);
    expect(aborted).toBe(true);
    expect((await ob.get("k"))!.lastError).toBe("timed out after 20 ms");
  });

  it("respects limit", async () => {
    const { ob } = setup();
    for (let i = 0; i < 5; i++) await ob.enqueue(`k${i}`, "x", {});
    expect((await ob.drain({ handlers: { x: async () => {} }, limit: 2 })).sent).toBe(2);
    expect((await ob.drain({ handlers: { x: async () => {} } })).sent).toBe(3);
  });

  it("claims a 'sending' item again once it is stale (its worker crashed mid-send)", async () => {
    const c = clock(), store = new MemoryStore(), ob = new Outbox(store, { now: c.now, staleMs: 60_000 });
    await ob.enqueue("k", "x", {});
    await store.claim(new Date(c.now()), new Date(0)); // a worker took it and died
    expect((await ob.drain({ handlers: { x: async () => {} } })).sent).toBe(0);
    c.advance(60_001);
    expect((await ob.drain({ handlers: { x: async () => {} } })).sent).toBe(1);
    expect(await ob.get("k")).toMatchObject({ state: "done", attempts: 2 });
  });
});

describe("exponentialBackoff", () => {
  it("doubles from base, caps at max", () => {
    const b = exponentialBackoff({ baseMs: 2000, maxMs: 600_000, jitter: 0 });
    expect([1, 2, 3, 4, 5, 10, 30].map(b)).toEqual([2000, 4000, 8000, 16000, 32000, 600_000, 600_000]);
  });
  it("adds ± jitter around the delay, never above max", () => {
    expect(exponentialBackoff({ baseMs: 1000, jitter: 0.2, random: () => 0 })(1)).toBe(800);
    expect(exponentialBackoff({ baseMs: 1000, jitter: 0.2, random: () => 0.5 })(1)).toBe(1000);
    expect(exponentialBackoff({ baseMs: 1000, jitter: 0.2, random: () => 0.999999 })(1)).toBe(1200);
    expect(exponentialBackoff({ baseMs: 1000, maxMs: 1000, jitter: 0.5, random: () => 0.99 })(1)).toBe(1000);
  });
  it("is used by drain with jitter by default", async () => {
    const { ob, c } = setup();
    await ob.enqueue("k", "x", {});
    await ob.drain({ handlers: { x: async () => { throw new Error("x"); } } });
    const wait = (await ob.get("k"))!.nextAt.getTime() - c.now();
    expect(wait).toBeGreaterThanOrEqual(1600);
    expect(wait).toBeLessThanOrEqual(2400);
  });
});

describe("enqueueAgain / latest / status / current", () => {
  it("first time uses the base key", async () => {
    const { ob } = setup();
    expect(await ob.enqueueAgain("ship:o1", "item.ship", { n: 1 })).toBe(true);
    expect((await ob.latest("ship:o1"))!.key).toBe("ship:o1");
  });

  it("is a no-op while the last one is pending or sending", async () => {
    const { ob, store, c } = setup();
    await ob.enqueueAgain("ship:o1", "item.ship", {});
    expect(await ob.enqueueAgain("ship:o1", "item.ship", {})).toBe(false);
    await store.claim(new Date(c.now()), new Date(0)); // now sending
    expect(await ob.enqueueAgain("ship:o1", "item.ship", {})).toBe(false);
    expect(store.all()).toHaveLength(1);
  });

  it("queues base:<ms> once the last is done or failed, and latest follows it", async () => {
    const { ob, c } = setup();
    await ob.enqueueAgain("ship:o1", "item.ship", { round: 1 });
    await ob.drain({ handlers: { "item.ship": async () => {} } });
    c.advance(5);
    expect(await ob.enqueueAgain("ship:o1", "item.ship", { round: 2 })).toBe(true);
    const second = await ob.latest("ship:o1");
    expect(second).toMatchObject({ key: `ship:o1:${c.now()}`, state: "pending", payload: { round: 2 } });

    await ob.drain({ handlers: { "item.ship": async () => { throw new Error("no"); } }, maxAttempts: 1 });
    expect((await ob.latest("ship:o1"))!.state).toBe("failed");
    expect(await ob.enqueueAgain("ship:o1", "item.ship", { round: 3 })).toBe(true); // "try again" after failed
    expect((await ob.latest("ship:o1"))!.payload).toEqual({ round: 3 });
  });

  it("gets a unique key even within the same millisecond", async () => {
    const { ob, store } = setup();
    for (let i = 0; i < 3; i++) { await ob.enqueueAgain("b", "x", i); await ob.drain({ handlers: { x: async () => {} } }); }
    expect(new Set(store.all().map((r) => r.key)).size).toBe(3);
  });

  it("latest doesn't mix bases that share a prefix", async () => {
    const { ob } = setup();
    await ob.enqueue("ship:o1", "x", 1);
    await ob.enqueue("ship:o10", "x", 10);
    expect((await ob.latest("ship:o1"))!.payload).toBe(1);
    expect(await ob.latest("ship:o")).toBeNull();
  });

  it("status gives the UI state, attempts, error and when it was queued", async () => {
    const { ob, c } = setup();
    expect(await ob.status("ship:o1")).toBeNull();
    const tapped = new Date(c.now()).toISOString();
    await ob.enqueueAgain("ship:o1", "item.ship", {});
    c.advance(3000);
    await ob.drain({ handlers: { "item.ship": async () => { throw new Error("Server error 503"); } }, backoff: fixed(1000) });
    expect(await ob.status("ship:o1")).toEqual({ key: "ship:o1", kind: "item.ship", state: "pending", attempts: 1, error: "Server error 503", since: tapped, updatedAt: new Date(c.now()).toISOString() });
  });

  it("current picks the newest open action across bases, null when all are done", async () => {
    const { ob } = setup();
    const bases = ["ship:o1", "refund:o1", "refund-decline:o1"];
    expect(await ob.current(bases)).toBeNull();
    await ob.enqueueAgain("ship:o1", "item.ship", {});
    await ob.drain({ handlers: { "item.ship": async () => {} } });
    expect(await ob.current(bases)).toBeNull(); // done → nothing on its way
    await ob.enqueueAgain("refund:o1", "item.refund", {});
    expect(await ob.current(bases)).toMatchObject({ kind: "item.refund", state: "pending" });
  });
});
