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

  it("publishing: a post the moderator removes gets no proof on NEAR", async () => {
    const post: Record<string, unknown> = { id: "p1", handle: "shoes", status: "scheduled", caption: "x", imageMediaId: null, idea: {} };
    const proofs: string[] = [];
    const tasks = makeContentTasks({
      content: { getPost: async () => post, getMedia: async () => null, updatePost: async (_: string, p: Record<string, unknown>) => { Object.assign(post, p); } },
      envelopes: { add: async () => {} }, router: {}, env, mediaDir: "/tmp", accountOf: (h: string) => h, decimals: 6, log: () => {},
      outbox: { enqueue: async (k: string) => { proofs.push(k); } }, moderateBeforePublish: async () => true,
    } as unknown as ContentTaskDeps);
    await tasks.publish_post!({ postId: "p1" }, { addJob: async () => {} } as never);
    expect(post.status).toBe("published");
    expect(proofs).toEqual([]);
    // A moderation outage never blocks publishing.
    post.status = "scheduled";
    const t2 = makeContentTasks({
      content: { getPost: async () => post, getMedia: async () => null, updatePost: async (_: string, p: Record<string, unknown>) => { Object.assign(post, p); } },
      envelopes: { add: async () => {} }, router: {}, env, mediaDir: "/tmp", accountOf: (h: string) => h, decimals: 6, log: () => {},
      outbox: { enqueue: async (k: string) => { proofs.push(k); } }, moderateBeforePublish: async () => { throw new Error("model down"); },
    } as unknown as ContentTaskDeps);
    await t2.publish_post!({ postId: "p1" }, { addJob: async () => {} } as never);
    expect(proofs).toEqual(["proof:post:p1"]);
  });
});
