import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentEnv } from "@nearchant/swarm";
import { SUSPEND_AFTER, makeMarketTasks, type MarketTaskDeps } from "../src/market-tasks.js";
import { makeContentTasks, type ContentTaskDeps } from "../src/content-tasks.js";

const env = loadAgentEnv(join(import.meta.dirname, "../../../envs/content-store"));
/** A router whose chat answer is `verdict` for the moderator. */
const routerSaying = (verdict: unknown) => ({ call: async () => ({ output: { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }, model: "fake" }) });

function setup(verdict: unknown) {
  const posts = new Map<string, Record<string, unknown>>();
  const removed: string[] = [], suspended: string[] = [], decided: [number, string][] = [], notified: string[] = [];
  let violations = 0;
  const content = {
    getPost: async (id: string) => posts.get(id) ?? null, getBusiness: async () => ({ name: "Shoes", description: "sneakers" }), getMedia: async () => null,
    getSetting: async (k: string) => (k.startsWith("emailOf:") ? "owner@example.com" : null), getProfile: async () => null,
    updatePost: async (id: string, patch: Record<string, unknown>) => { Object.assign(posts.get(id)!, patch); },
    listPosts: async () => [...posts.values()],
  };
  const feed = {
    getReport: async (id: number) => ({ id, reason: "counterfeit", note: "fake logo" }),
    removePost: async (id: string) => { removed.push(id); posts.get(id)!.removedAt = new Date(); return { handle: "shoes", count: ++violations }; },
    suspendStore: async (h: string) => { suspended.push(h); }, decideReport: async (id: number, status: string) => { decided.push([id, status]); }, log: async () => {},
  };
  const d = { content, feed, envelopes: { add: async () => {} }, router: routerSaying(verdict), env, mediaDir: mkdtempSync(join(tmpdir(), "nc-m-")),
    accountOf: (h: string) => `${h}.nearchant.testnet`, log: () => {}, notify: async (h: string, subject: string) => { notified.push(`${h}:${subject}`); } } as unknown as MarketTaskDeps;
  const add = (id: string) => posts.set(id, { id, handle: "shoes", status: "published", caption: "1:1 replica", hashtags: [], idea: {} });
  return { m: makeMarketTasks(d), posts, add, removed, suspended, decided, notified };
}

describe("moderation agent", () => {
  it("removes a confident violation, decides the report, tells the owner, suspends after repeated removals", async () => {
    const t = setup({ violation: true, category: "counterfeit", confidence: 0.95, summary: "Replica sneakers" });
    for (let i = 1; i <= SUSPEND_AFTER; i++) { t.add(`p${i}`); await t.m.tasks.moderate_post!({ postId: `p${i}`, reportId: i }, {} as never); }
    expect(t.removed).toEqual(["p1", "p2", "p3"]);
    expect(t.posts.get("p1")!.moderation).toMatchObject({ violation: true, category: "counterfeit", reportId: 1 });
    expect(t.decided).toEqual([[1, "auto_removed"], [2, "auto_removed"], [3, "auto_removed"]]);
    expect(t.notified).toHaveLength(3);
    expect(t.suspended).toEqual(["shoes"]);
  });

  it("keeps a fine post and marks the report as kept by the AI", async () => {
    const t = setup({ violation: false, category: "ok", confidence: 0.9, summary: "fine" });
    t.add("p1");
    await t.m.tasks.moderate_post!({ postId: "p1", reportId: 7 }, {} as never);
    expect(t.removed).toEqual([]);
    expect(t.decided).toEqual([[7, "auto_kept"]]);
  });

  it("publishing: a post the safety check flags goes back to the owner as a draft — not published, not removed", async () => {
    const post: Record<string, unknown> = { id: "p1", handle: "shoes", status: "scheduled", caption: "x", imageMediaId: null, idea: {} };
    const proofs: string[] = [];
    const tasks = makeContentTasks({
      content: { getPost: async () => post, getMedia: async () => null, updatePost: async (_: string, p: Record<string, unknown>) => { Object.assign(post, p); } },
      envelopes: { add: async () => {} }, router: {}, env, mediaDir: "/tmp", accountOf: (h: string) => h, decimals: 6, log: () => {},
      outbox: { enqueue: async (k: string) => { proofs.push(k); } },
      safetyCheck: async () => ({ violation: true, category: "scam", confidence: 0.75, summary: "Asks buyers to order in a private channel", at: "t" }),
    } as unknown as ContentTaskDeps);
    await tasks.publish_post!({ postId: "p1" }, { addJob: async () => {} } as never);
    expect(post.status).toBe("ready");
    expect(post.publishedAt).toBeUndefined();
    expect((post.idea as { safety: { flagged: boolean; held: boolean; summary: string } }).safety).toMatchObject({ flagged: true, held: true, summary: "Asks buyers to order in a private channel" });
    expect(proofs).toEqual([]);
    // A moderation outage never blocks publishing.
    post.status = "scheduled";
    const t2 = makeContentTasks({
      content: { getPost: async () => post, getMedia: async () => null, updatePost: async (_: string, p: Record<string, unknown>) => { Object.assign(post, p); } },
      envelopes: { add: async () => {} }, router: {}, env, mediaDir: "/tmp", accountOf: (h: string) => h, decimals: 6, log: () => {},
      outbox: { enqueue: async (k: string) => { proofs.push(k); } }, safetyCheck: async () => { throw new Error("model down"); },
    } as unknown as ContentTaskDeps);
    await t2.publish_post!({ postId: "p1" }, { addJob: async () => {} } as never);
    expect(proofs).toEqual(["proof:post:p1"]);
  });
});

describe("item moderation", () => {
  it("holds a flagged item with the reason (no violation), keeps it held for the same text, releases it once fixed", async () => {
    const settings = new Map<string, unknown>(), held: (string | null)[] = [], violations: string[] = [];
    let calls = 0;
    const item = { id: "i-1", title: "Glock 19", description: "No license needed", photoMediaId: null, kind: "product", priceUnits: "1", options: [], active: true, held: null as string | null };
    const d = { content: { getBusiness: async () => ({ name: "Guns", description: "" }),  getProfile: async () => null, getMedia: async () => null, listItems: async () => [item],
        getSetting: async (k: string) => settings.get(k) ?? null, setSetting: async (k: string, v: unknown) => { settings.set(k, v); },
        setItemHeld: async (_h: string, _id: string, r: string | null) => { held.push(r); item.held = r; } },
      feed: { vectorHash: async () => null, putVector: async () => {}, recordViolation: async (_k: string, _h: string, _id: unknown, v: { summary: string }) => { violations.push(v.summary); return 1; }, log: async () => {} },
      envelopes: { add: async () => {} }, env, mediaDir: "/tmp", accountOf: (h: string) => h, log: () => {},
      router: { call: async (r: { capability: string; input: unknown }) => { if (r.capability === "embed") return { output: { vectors: [[1]] } };
        if (JSON.stringify(r.input).includes("Store name:")) return { output: { message: { content: JSON.stringify({ violation: false, category: "ok", confidence: 0.9, summary: "fine" }) }, finish_reason: "stop" }, model: "fake" };
        calls++;
        const bad = JSON.stringify(r.input).includes("No license");
        return { output: { message: { content: JSON.stringify(bad ? { violation: true, category: "illegal", confidence: 0.97, summary: "Sells a handgun without a licence" } : { violation: false, category: "ok", confidence: 0.9, summary: "fine" }) }, finish_reason: "stop" }, model: "fake" }; } },
    } as unknown as MarketTaskDeps;
    const m = makeMarketTasks(d);
    await m.tasks.index_store!({ handle: "guns" }, {} as never);
    expect(held).toEqual(["Sells a handgun without a licence"]);
    expect(violations).toEqual([]);                               // our own check: no strike against the store
    item.held = null;                                             // the owner saved it again unchanged (save clears it)
    await m.tasks.index_store!({ handle: "guns" }, {} as never);
    expect(calls).toBe(1);                                        // no second model call
    expect(item.held).toBe("Sells a handgun without a licence");  // held again
    item.description = "Airsoft replica, licence not required";   // fixed
    await m.tasks.index_store!({ handle: "guns" }, {} as never);
    expect(calls).toBe(2);
    expect(item.held).toBeNull();
  });
});

describe("store profile moderation", () => {
  it("pauses a store whose own name or description breaks the rules, once per text", async () => {
    const settings = new Map<string, unknown>(), suspended: string[] = [];
    let calls = 0;
    const d = { content: { getBusiness: async () => ({ name: "Cocaine Express", description: "Pure cocaine, fast delivery" }), getProfile: async () => null, listItems: async () => [],
        getSetting: async (k: string) => settings.get(k) ?? null, setSetting: async (k: string, v: unknown) => { settings.set(k, v); } },
      feed: { vectorHash: async () => null, putVector: async () => {}, recordViolation: async () => 1, suspendStore: async (h: string) => { suspended.push(h); }, log: async () => {} },
      envelopes: { add: async () => {} }, env, mediaDir: "/tmp", accountOf: (h: string) => h, log: () => {},
      router: { call: async () => { calls++; return { output: { message: { content: JSON.stringify({ violation: true, category: "illegal", confidence: 0.99, summary: "Sells illegal drugs" }) }, finish_reason: "stop" }, model: "fake" }; } },
    } as unknown as MarketTaskDeps;
    const m = makeMarketTasks(d);
    await m.tasks.index_store!({ handle: "coke" }, {} as never);
    await m.tasks.index_store!({ handle: "coke" }, {} as never);
    expect(suspended).toEqual(["coke"]);
    expect(calls).toBe(1);
  });
});

describe("store profile moderation is cautious", () => {
  it("never pauses a store for 'spam' or a weak call", async () => {
    for (const verdict of [{ violation: true, category: "spam", confidence: 0.99, summary: "generic" }, { violation: true, category: "illegal", confidence: 0.7, summary: "maybe" }]) {
      const suspended: string[] = [];
      const d = { content: { getBusiness: async () => ({ name: "Super Nutrition", description: "Sports supplements" }), getProfile: async () => null, listItems: async () => [], getSetting: async () => null, setSetting: async () => {} },
        feed: { vectorHash: async () => "same", putVector: async () => {}, recordViolation: async () => 1, suspendStore: async (h: string) => { suspended.push(h); }, log: async () => {} },
        envelopes: { add: async () => {} }, env, mediaDir: "/tmp", accountOf: (h: string) => h, log: () => {},
        router: { call: async (r: { capability: string }) => (r.capability === "embed" ? { output: { vectors: [[1]] } } : { output: { message: { content: JSON.stringify(verdict) }, finish_reason: "stop" }, model: "fake" }) } } as unknown as MarketTaskDeps;
      await makeMarketTasks(d).tasks.index_store!({ handle: "supernutrition" }, {} as never);
      expect(suspended).toEqual([]);
    }
  });
});

describe("weekly report", () => {
  it("emails owners with a linked email a week summary from real numbers, nothing for a silent week", async () => {
    const sent: { h: string; lines: string[]; key: string }[] = [];
    const biz = [{ handle: "busy", name: "Busy", suspendedAt: null }, { handle: "quiet", name: "Quiet", suspendedAt: null }, { handle: "nomail", name: "No mail", suspendedAt: null }];
    const d = {
      content: { listBusinesses: async () => biz, getSetting: async (k: string) => (k === "emailOf:busy" || k === "emailOf:quiet" ? "o@example.com" : k === "questions:busy" ? [{ q: "Is it merino?", owner: true, at: new Date().toISOString() }] : null),
        eventCounts: async (h: string) => (h === "busy" ? [{ day: "d", kind: "view", n: 12 }] : []), salesSince: async (h: string) => (h === "busy" ? { count: 1, units: 40_000_000n } : { count: 0, units: 0n }) },
      feed: { searchesFor: async (h: string) => (h === "busy" ? { count: 3, goods: ["denim jacket"] } : { count: 0, goods: [] }) },
      envelopes: { add: async () => {} }, router: {}, env, mediaDir: "/tmp", accountOf: (h: string) => h, log: () => {}, decimals: 6, token: "nUSD",
      weeklyMail: async (h: string, _s: string, lines: string[], key: string) => { sent.push({ h, lines, key }); return true; },
    } as unknown as MarketTaskDeps;
    await makeMarketTasks(d).tasks.weekly_report!({}, {} as never);
    expect(sent.map((x) => x.h)).toEqual(["busy"]);
    expect(sent[0]!.lines[0]).toBe("Store views: 12. Sales: 1 (40 nUSD).");
    expect(sent[0]!.lines.join(" ")).toContain("denim jacket");
    expect(sent[0]!.lines.join(" ")).toContain("Is it merino?");
    expect(sent[0]!.key).toMatch(/^weekly:busy:\d{4}-\d{2}-\d{2}$/);
  });
});
