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

describe("postProofEntry with a TEE writer", () => {
  it("cites the NEAR AI report and the model, and keeps the brief hash independent of it", () => {
    const writer = { model: "Qwen/Qwen3.6-35B-A3B-FP8", tier: "tee", reportHash: "ef".repeat(32), signingAddress: "0xabc" };
    const a = postProofEntry({ id: "p-1", caption: "c", imageSha256: null, idea: { angle: "trend", writer } });
    const plain = postProofEntry({ id: "p-1", caption: "c", imageSha256: null, idea: { angle: "trend" } });
    expect(a.attestation_ref).toBe(`nearai:Qwen/Qwen3.6-35B-A3B-FP8:${"ef".repeat(32)}`);
    expect(a.producer).toContain("Qwen/Qwen3.6-35B-A3B-FP8");
    expect(a.brief_hash).toBe(plain.brief_hash);
    expect(plain.attestation_ref).toBeNull();
    expect(postProofEntry({ id: "p", caption: "c", imageSha256: null, idea: { writer: { model: "qwen3.6-35b-a3b", tier: "local" } } }).attestation_ref).toBeNull();
  });
});
