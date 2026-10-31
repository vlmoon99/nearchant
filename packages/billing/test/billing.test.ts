import { describe, expect, it } from "vitest";
import type { ResultEnvelope } from "@nearchant/contracts";
import { buildBatch, chargeUnits, leafHash, merkleProof, merkleRoot, usageRecord, verifyProof } from "../src/index.js";

const p = { marginBps: 1000, unitsPerUsd: 1_000_000 };
const env = (costUsd: number, privacyTier: "tee" | "local" = "tee"): ResultEnvelope => ({
  capability: "chat", output: {}, model: "m", endpointId: "nearai", privacyTier, usage: { inputTokens: 1 }, costUsd,
  requestHash: "a".repeat(64), outputHash: "b".repeat(64), latencyMs: 1, createdAt: "2026-11-01T00:00:00.000Z",
});

describe("billing", () => {
  it("charges cost + margin, rounded up; local is free", () => {
    expect(chargeUnits(env(0.012), p)).toBe(13_200n);
    expect(chargeUnits(env(0.0000001), p)).toBe(1n);
    expect(chargeUnits(env(5, "local"), p)).toBe(0n);
  });

  it("builds batches with per-account totals and a verifiable Merkle root", () => {
    const recs = [
      usageRecord("r1", "alice.nearchant.testnet", env(0.012), p),
      usageRecord("r2", "alice.nearchant.testnet", env(0.001), p),
      usageRecord("r3", "bob.nearchant.testnet", env(0.002, "local"), p),
    ];
    const b = buildBatch("b1", recs);
    expect(b.entries).toEqual([{ account_id: "alice.nearchant.testnet", amount: String(13_200 + 1_100) }]);
    expect(b.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    const leaves = recs.map(leafHash);
    for (let i = 0; i < leaves.length; i++) expect(verifyProof(leaves[i]!, merkleProof(leaves, i), b.merkleRoot)).toBe(true);
    const tampered = leafHash({ ...recs[1]!, chargeUnits: "999999" });
    expect(verifyProof(tampered, merkleProof(leaves, 1), b.merkleRoot)).toBe(false);
    expect(merkleRoot([leaves[0]!])).toBe(leaves[0]);
  });
});
