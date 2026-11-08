import { describe, expect, it } from "vitest";
import { followAction, formatElapsed, type ActionStatus, type FollowUpdate } from "../src/index.js";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const st = (p: Partial<ActionStatus>): ActionStatus => ({ key: "ship:o1", kind: "item.ship", state: "pending", attempts: 0, error: null, since: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), ...p });

/** Fake time: sleep advances the clock instantly. */
const fake = (start: number) => {
  let t = start;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
};
const run = async (seq: (ActionStatus | null | Error)[], start = T0 + 5000, extra = {}) => {
  const f = fake(start), ups: FollowUpdate[] = [];
  let i = 0;
  const phase = await followAction(async () => { const v = seq[Math.min(i++, seq.length - 1)]; if (v instanceof Error) throw v; return v ?? null; }, (u) => ups.push(u), { now: f.now, sleep: f.sleep, ...extra });
  return { phase, ups, f };
};

describe("followAction", () => {
  it("reports working, then done; elapsed counts from the tap (since), not from the page load", async () => {
    const { phase, ups } = await run([st({}), st({ state: "sending", attempts: 1 }), st({ state: "done", attempts: 1 })]);
    expect(phase).toBe("done");
    expect(ups.map((u) => u.phase)).toEqual(["working", "working", "done"]);
    expect(ups[0]!.elapsed).toBe("5 s"); // the page opened 5 s after the tap
    expect(ups[1]!.elapsed).toBe("7 s");
  });

  it("treats null as done (nothing on its way)", async () => expect((await run([st({}), null])).phase).toBe("done"));

  it("says retrying with the error in plain words", async () => {
    const { ups } = await run([st({ attempts: 1, error: "fetch failed" }), st({ state: "done" })]);
    expect(ups[0]).toMatchObject({ phase: "retrying", why: "NEAR is slow to answer right now." });
  });

  it("stops on failed", async () => {
    const { phase, ups } = await run([st({ state: "failed", attempts: 8, error: "Only the seller" })]);
    expect(phase).toBe("failed");
    expect(ups.at(-1)!.why).toBe("Your key on NEAR didn't sign it.");
  });

  it("keeps polling through network errors, stops on 404", async () => {
    expect((await run([new Error("offline"), st({}), st({ state: "done" })])).phase).toBe("done");
    expect((await run([st({}), Object.assign(new Error("not found"), { status: 404 })])).phase).toBe("gone");
  });

  it("doesn't count from a server clock that is ahead", async () => {
    const { ups } = await run([st({ since: new Date(T0 + 60_000).toISOString() }), null], T0);
    expect(ups[0]!.elapsedMs).toBe(0);
  });

  it("slows down after a while and gives up at maxMs", async () => {
    const { phase, f } = await run([st({})], T0, { intervalMs: 1000, slowAfterMs: 3000, slowMs: 5000, maxMs: 20_000 });
    expect(phase).toBe("timeout");
    expect(f.slept.slice(0, 5)).toEqual([1000, 1000, 1000, 1000, 5000]);
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await run([st({})], T0, { signal: ac.signal })).phase).toBe("stopped");
  });

  it("formats elapsed time", () => {
    expect([0, 1499, 59_000, 60_000, 125_000].map(formatElapsed)).toEqual(["0 s", "1 s", "59 s", "1 min 0 s", "2 min 5 s"]);
  });
});
