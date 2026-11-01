import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNearAiReport, quoteReportData } from "../src/attest-verify.js";

// A real NEAR AI report (1 Nov 2026, Qwen3.6-35B-A3B on NEAR AI TEE) — public data.
const raw = readFileSync(join(import.meta.dirname, "fixtures-nearai-report.json"), "utf8");
const nonce = (JSON.parse(raw) as { gateway_attestation: { request_nonce: string } }).gateway_attestation.request_nonce;
const phala = (verified: boolean | "down") => (async () => verified === "down" ? new Response("x", { status: 503 }) : new Response(JSON.stringify({ success: true, quote: { verified } }))) as unknown as typeof fetch;

describe("NEAR AI attestation report check", () => {
  it("binds NEAR AI's key and our nonce into the TDX quotes; TDX verified by Phala", async () => {
    const c = await checkNearAiReport(raw, nonce, { fetch: phala(true) });
    expect(c).toMatchObject({ nonce_ok: true, gateway_bound: true, compose_bound: true, gateway_tdx_verified: true, ok: true });
    expect(c.models[0]).toMatchObject({ model: "Qwen/Qwen3.6-35B-A3B-FP8", bound: true, gpu_nonce_ok: true, tdx_verified: true });
  });
  it("fails for another nonce (replayed report) and when the verifier rejects the quote", async () => {
    expect((await checkNearAiReport(raw, "00".repeat(32), { fetch: phala(true) })).ok).toBe(false);
    expect((await checkNearAiReport(raw, nonce, { fetch: phala(false) })).ok).toBe(false);
  });
  it("a swapped signing key no longer matches the quote", async () => {
    const j = JSON.parse(raw); j.gateway_attestation.signing_address = "ab".repeat(32);
    expect((await checkNearAiReport(JSON.stringify(j), nonce, { tdx: false })).gateway_bound).toBe(false);
  });
  it("an unreachable verifier is 'unknown', not a failure", async () => {
    const c = await checkNearAiReport(raw, nonce, { fetch: phala("down") });
    expect(c.gateway_tdx_verified).toBeNull();
    expect(c.ok).toBe(true);
  });
  it("reads REPORTDATA from a TDX v4 quote and refuses other data", () => {
    expect(quoteReportData((JSON.parse(raw) as any).gateway_attestation.intel_quote)).toHaveLength(128);
    expect(() => quoteReportData("00")).toThrow();
  });
});
