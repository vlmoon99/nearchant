import { describe, expect, it } from "vitest";
import { postProofEntry } from "../src/content-tasks.js";

describe("postProofEntry", () => {
  it("binds the caption and the exact image, and fits proof-log's limits", () => {
    const a = postProofEntry({ id: "p-1", caption: "Linen season", imageSha256: "ab".repeat(32), idea: { angle: "trend" } });
    const b = postProofEntry({ id: "p-1", caption: "Linen season", imageSha256: "cd".repeat(32), idea: { angle: "trend" } });
    expect(a.task_id).toBe("post:p-1");
    expect(a.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.output_hash).not.toBe(b.output_hash); // a different picture is a different proof
    expect(postProofEntry({ id: "p-1", caption: "Linen season", imageSha256: "ab".repeat(32), idea: { angle: "trend" } }).output_hash).toBe(a.output_hash);
    expect(a.producer.length).toBeLessThanOrEqual(200);
  });
});
