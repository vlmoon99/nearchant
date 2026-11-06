import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { checkNearAiReport, nrasVerify, quoteReportData } from "../src/attest-verify.js";

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
  it("an unreachable verifier is 'unknown' — and not ok", async () => {
    const c = await checkNearAiReport(raw, nonce, { fetch: phala("down") });
    expect(c.gateway_tdx_verified).toBeNull();
    expect(c.gateway_bound).toBe(true);
    expect(c.ok).toBe(false);
  });
  it("accepts an ECDSA gateway address (20 bytes, zero-padded) bound into REPORTDATA — and nothing looser", async () => {
    const j = JSON.parse(raw) as any;
    const rd = quoteReportData(j.gateway_attestation.intel_quote);
    const asAddress = (addr: string) => checkNearAiReport(JSON.stringify({ ...j, gateway_attestation: { ...j.gateway_attestation, signing_address: addr } }), nonce, { tdx: false });
    // The fixture's 32-byte key: its first 20 bytes as an "address" only bind if the other 12 bytes are zero.
    const first20 = rd.slice(0, 40), rest12 = rd.slice(40, 64);
    expect((await asAddress(`0x${first20}`)).gateway_bound).toBe(/^0+$/.test(rest12));
    expect((await asAddress(`0x${rd.slice(0, 64)}`)).gateway_bound).toBe(true);
    expect((await asAddress("0x1234")).gateway_bound).toBe(false);
  });
  it("a real report in NEAR AI's ECDSA format (6 Nov 2026) binds the gateway address and our nonce", async () => {
    const raw2 = readFileSync(join(import.meta.dirname, "fixtures-nearai-report-ecdsa.json"), "utf8");
    const n2 = (JSON.parse(raw2) as { gateway_attestation: { request_nonce: string } }).gateway_attestation.request_nonce;
    const c = await checkNearAiReport(raw2, n2, { fetch: phala(true) });
    expect(c).toMatchObject({ nonce_ok: true, gateway_bound: true, compose_bound: true, ok: true });
    expect(c.models[0]).toMatchObject({ bound: true, gpu_nonce_ok: true });
  });
  it("a third-party attested model (Kimi K2.6 via Chutes): nonce, quote binding and every GPU's evidence check out", async () => {
    const raw3 = readFileSync(join(import.meta.dirname, "fixtures-nearai-report-kimi.json"), "utf8");
    const j3 = JSON.parse(raw3) as any, n3 = j3.gateway_attestation.request_nonce as string;
    const c = await checkNearAiReport(raw3, n3, { fetch: phala(true) });
    expect(c.models[0]).toMatchObject({ model: "moonshotai/kimi-k2.6", bound: true, gpu_nonce_ok: true, tdx_verified: true });
    expect(c.nonce_ok).toBe(true);
    // Another model key → the quote no longer binds.
    j3.model_attestations[0].e2e_pubkey = "AAAA";
    expect((await checkNearAiReport(JSON.stringify(j3), n3, { tdx: false })).models[0]!.bound).toBe(false);
  });
  it("reads REPORTDATA from a TDX v4 quote and refuses other data", () => {
    expect(quoteReportData((JSON.parse(raw) as any).gateway_attestation.intel_quote)).toHaveLength(128);
    expect(() => quoteReportData("00")).toThrow();
  });
});

// A stand-in NRAS: signs ES384 tokens with a key of ours and serves its JWKS (the real one refuses this network).
function fakeNras(o: { result?: boolean; nonce?: string; status?: number; forge?: boolean } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const other = generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey;
  const b64 = (x: object | Buffer) => (Buffer.isBuffer(x) ? x : Buffer.from(JSON.stringify(x))).toString("base64url");
  const jwt = (claims: object) => {
    const head = `${b64({ alg: "ES384", kid: "k1" })}.${b64(claims)}`;
    return `${head}.${b64(createSign("SHA384").update(head).sign({ key: o.forge ? other : privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  const seen: { url: string; auth?: string; body?: any }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] }));
    if (url.includes("phala")) return new Response(JSON.stringify({ success: true, quote: { verified: true } }));
    if (o.status) return new Response("<title>403</title>", { status: o.status });
    const n = (seen.at(-1)!.body as { nonce: string }).nonce;
    return new Response(JSON.stringify([["JWT", jwt({ "x-nvidia-overall-att-result": o.result ?? true, eat_nonce: o.nonce ?? n, exp: Math.floor(Date.now() / 1000) + 3600 })], { "GPU-0": jwt({ "x-nvidia-gpu-attestation-report-nonce-match": true }) }]));
  }) as unknown as typeof fetch;
  return { f, seen };
}
const gpuPayload = () => (JSON.parse(raw) as any).model_attestations[0].nvidia_payload as string;

describe("NVIDIA NRAS check of the GPU evidence", () => {
  it("sends the SDK's request with the key and accepts NVIDIA's signed 'true' for our nonce", async () => {
    const { f, seen } = fakeNras();
    expect(await nrasVerify(gpuPayload(), nonce, { apiKey: "nvapi-x", fetch: f })).toMatchObject({ verified: true, token: expect.stringMatching(/^ey/) });
    expect(seen[0]).toMatchObject({ url: "https://nras.attestation.nvidia.com/v4/attest/gpu", auth: "Bearer nvapi-x" });
    expect(Object.keys(seen[0]!.body).sort()).toEqual(["arch", "claims_version", "evidence_list", "nonce"]);
  });
  it("NVIDIA's 'false', another nonce or a forged signature fail", async () => {
    expect((await nrasVerify(gpuPayload(), nonce, { apiKey: "k", fetch: fakeNras({ result: false }).f })).verified).toBe(false);
    expect((await nrasVerify(gpuPayload(), nonce, { apiKey: "k", fetch: fakeNras({ nonce: "ab".repeat(32) }).f })).verified).toBe(false);
    expect((await nrasVerify(gpuPayload(), nonce, { apiKey: "k", fetch: fakeNras({ forge: true }).f })).verified).toBe(false);
  });
  it("a refused or unreachable NRAS is 'not checked', and the report check still decides on the rest", async () => {
    const { f } = fakeNras({ status: 403 });
    expect(await nrasVerify(gpuPayload(), nonce, { apiKey: "k", fetch: f })).toEqual({ verified: null, error: "NRAS 403" });
    const c = await checkNearAiReport(raw, nonce, { fetch: f, nvidia: { apiKey: "k" } });
    expect(c.models[0]).toMatchObject({ gpu_verified: null, gpu_error: "NRAS 403" });
    expect(c.ok).toBe(true);
  });
  it("a relay can stand in for NRAS's address; NVIDIA's 'false' makes the whole check fail", async () => {
    const { f, seen } = fakeNras({ result: false });
    const c = await checkNearAiReport(raw, nonce, { fetch: f, nvidia: { apiKey: "k", baseUrl: "https://relay.example/" } });
    expect(seen.find((s) => s.url.includes("attest"))!.url).toBe("https://relay.example/v4/attest/gpu");
    expect(c.models[0]!.gpu_verified).toBe(false);
    expect(c.ok).toBe(false);
  });
});
