import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentEnv } from "@nearchant/swarm";
import { makeContentTasks, type ContentTaskDeps } from "../src/content-tasks.js";

function deps(post: Record<string, unknown>, over: Partial<ContentTaskDeps> = {}) {
  const refunds: number[] = [];
  const content = {
    getPost: async () => post, getMedia: async () => null, getProfile: async () => ({ data: {} }),
    updatePost: async (_id: string, patch: Record<string, unknown>) => { Object.assign(post, patch); },
    refund: async (_h: string, _p: number, images: number) => { refunds.push(images); },
  };
  const d = {
    content, envelopes: { add: async () => {} }, router: {}, env: loadAgentEnv(join(import.meta.dirname, "../../../envs/content-store")),
    mediaDir: mkdtempSync(join(tmpdir(), "nc-v-")), accountOf: (h: string) => h, decimals: 6, log: () => {}, outbox: { enqueue: async () => {} },
    video: { render: async () => { throw new Error("no render in this test"); }, tts: { speak: async () => { throw new Error("no tts"); } }, fontsDir: "/f" },
    ...over,
  } as unknown as ContentTaskDeps;
  return { tasks: makeContentTasks(d), refunds };
}

describe("make_video", () => {
  it("fails without a picture: marks the video failed and refunds the 3 credits", async () => {
    const post = { id: "p1", handle: "nova", status: "ready", imageMediaId: null, sourceMediaId: null, idea: { angle: "a", video: { status: "writing" } } };
    const { tasks, refunds } = deps(post);
    await tasks.make_video!({ postId: "p1" }, {} as never);
    expect(post.idea).toMatchObject({ angle: "a", video: { status: "failed", error: "the post has no picture to animate" } });
    expect(refunds).toEqual([3]);
  });
  it("does nothing when video is not configured", async () => {
    const post = { id: "p1", handle: "nova", status: "ready", idea: {} };
    const { tasks, refunds } = deps(post, { video: undefined });
    await tasks.make_video!({ postId: "p1" }, {} as never);
    expect(post.idea).toEqual({});
    expect(refunds).toEqual([]);
  });
});
