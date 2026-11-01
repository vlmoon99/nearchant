import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validate } from "@nearchant/contracts";
import { NoEndpointError, ReplayStore, Router } from "../src/index.js";
import { fakeOpenAI, type Fake } from "./fake-server.js";

const fakes: Fake[] = [];
afterEach(async () => { await Promise.all(fakes.splice(0).map((f) => f.close())); });
const quiet = { log: () => {}, sleep: async () => {} };

async function two() {
  const local = await fakeOpenAI(["qwen3.6-35b-a3b"], "from-local");
  const tee = await fakeOpenAI(["Qwen/Qwen3.6-35B-A3B-FP8", "z-ai/glm-5.3"], "from-tee");
  const pub = await fakeOpenAI(["Qwen/Qwen3.6-35B-A3B-FP8"], "from-public");
  fakes.push(local, tee, pub);
  const config = {
    endpoints: [
      { id: "spark", base_url: local.url, privacy_tier: "local", capabilities: ["chat", "embed"],
        model_map: { "Qwen/Qwen3.6-35B-A3B-FP8": "qwen3.6-35b-a3b" } },
      { id: "nearai", base_url: tee.url, api_key_env: "NEARAI_API_KEY", privacy_tier: "tee", attestation: "nearai", capabilities: ["chat", "embed"] },
      { id: "pub", base_url: pub.url, privacy_tier: "public", capabilities: ["chat"] },
    ],
    routing: { chat: ["spark", "nearai", "pub"], embed: ["nearai"], private_data_allowed_tiers: ["tee", "local"] },
    models: { chat: ["Qwen/Qwen3.6-35B-A3B-FP8"], embed: ["Qwen/Qwen3-Embedding-0.6B"] },
    prices: { "Qwen/Qwen3.6-35B-A3B-FP8": { inputPerMTok: 1, outputPerMTok: 2 } },
  };
  return { local, tee, pub, config };
}

const chat = (dataClass: "private" | "public" = "private", model?: string) => ({
  capability: "chat" as const, dataClass, ...(model ? { model } : {}),
  input: { messages: [{ role: "user", content: "hi" }] },
});

describe("router", () => {
  it("passes reasoning: false as the chat-template flag without changing the replay key", async () => {
    const { local, config } = await two();
    const r = Router.fromConfig(config, { ...quiet, env: {} });
    await r.discover();
    const a = await r.call({ ...chat(), reasoning: false });
    const b = await r.call(chat());
    const bodies = local.hits.filter((h) => h.path === "/v1/chat/completions").map((h) => h.body);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[1].chat_template_kwargs).toBeUndefined();
    expect(a.requestHash).toBe(b.requestHash);
  });

  it("uses the first endpoint, maps the model name and returns a valid envelope", async () => {
    const { local, config } = await two();
    const r = Router.fromConfig(config, { ...quiet, env: {} });
    await r.discover();
    const env = await r.call(chat());
    expect(env.endpointId).toBe("spark");
    expect(env.model).toBe("qwen3.6-35b-a3b");
    expect(env.privacyTier).toBe("local");
    expect(env.costUsd).toBe(0);
    expect((env.output as any).message.content).toBe("from-local");
    expect(local.hits.find((h) => h.path === "/v1/chat/completions")!.body.model).toBe("qwen3.6-35b-a3b");
    validate("result-envelope.schema.json", env);
  });

  it("hands each new attestation report to the sink once, raw, and keeps it out of the envelope", async () => {
    const { local, config } = await two();
    local.failNext(100);
    const reports: { hash: string; model: string; raw: string }[] = [];
    const r = Router.fromConfig(config, { ...quiet, env: { NEARAI_API_KEY: "k" }, onAttestationReport: (ref, model, raw) => { reports.push({ hash: ref.reportHash, model, raw }); } });
    await r.discover();
    const a = await r.call(chat());
    await r.call(chat()); // cached for 10 minutes: no second report
    expect(reports).toHaveLength(1);
    expect(reports[0]!.raw).toContain("signing_address");
    expect(reports[0]!.hash).toBe(a.attestation!.reportHash);
    expect(JSON.stringify(a)).not.toContain("gateway_attestation");
    validate("result-envelope.schema.json", a);
  });

  it("falls back to the TEE endpoint when local fails, with attestation and cost", async () => {
    const { local, tee, config } = await two();
    local.failNext(10);
    const r = Router.fromConfig(config, { ...quiet, env: { NEARAI_API_KEY: "k" } });
    await r.discover();
    const env = await r.call(chat());
    expect(env.endpointId).toBe("nearai");
    expect(env.attestation?.kind).toBe("nearai");
    expect(env.attestation?.signingAddress).toBe("0xabc");
    expect(env.costUsd).toBeCloseTo((10 * 1 + 2 * 2) / 1e6);
    expect(tee.hits.find((h) => h.path === "/v1/chat/completions")!.auth).toBe("Bearer k");
    expect(local.hits.filter((h) => h.path === "/v1/chat/completions")).toHaveLength(2); // 1 retry
  });

  it("never sends private data to a public endpoint", async () => {
    const { local, tee, pub, config } = await two();
    local.failNext(10);
    tee.failNext(10);
    const r = Router.fromConfig(config, { ...quiet, env: {} });
    await r.discover();
    await expect(r.call(chat("private"))).rejects.toBeInstanceOf(NoEndpointError);
    expect(pub.hits.filter((h) => h.path === "/v1/chat/completions")).toHaveLength(0);
    local.failNext(10);
    tee.failNext(10);
    const env = await r.call(chat("public"));
    expect(env.endpointId).toBe("pub");
  });

  it("prices from the TEE catalog when config has none; local stays free", async () => {
    const { local, config } = await two();
    local.failNext(10);
    const r = Router.fromConfig({ ...config, prices: {} }, { ...quiet, env: {} });
    await r.discover();
    const env = await r.call(chat());
    expect(env.endpointId).toBe("nearai");
    expect(env.costUsd).toBeCloseTo((10 * 3 + 2 * 4) / 1e6); // catalog: $3/M in, $4/M out
  });

  it("a model without attestation is refused for private data but doesn't block the endpoint", async () => {
    const { tee, config } = await two();
    const cfg = { ...config, routing: { ...config.routing, chat: ["nearai"] } };
    let attestOk = false;
    const r = Router.fromConfig(cfg, { ...quiet, env: {} });
    await r.discover();
    // Fake: attestation fails for glm, works otherwise.
    (r as any).state.get("nearai").adapter.attest = async (m: string) => {
      if (m === "z-ai/glm-5.3" && !attestOk) throw new Error("503");
      return { kind: "nearai", reportHash: "e".repeat(64), fetchedAt: new Date().toISOString(), verified: false };
    };
    for (let i = 0; i < 4; i++) await expect(r.call(chat("private", "z-ai/glm-5.3"))).rejects.toBeInstanceOf(NoEndpointError);
    const ok = await r.call(chat("private")); // other models on the same endpoint still work
    expect(ok.endpointId).toBe("nearai");
    expect(r.health().nearai!.open).toBe(false);
    expect(tee.hits.filter((h) => h.path === "/v1/chat/completions").every((h) => h.body.model !== "z-ai/glm-5.3")).toBe(true);
  });

  it("skips endpoints that don't serve the requested model", async () => {
    const { config } = await two();
    const r = Router.fromConfig(config, { ...quiet, env: {} });
    await r.discover();
    const env = await r.call(chat("private", "z-ai/glm-5.3"));
    expect(env.endpointId).toBe("nearai");
    expect(env.model).toBe("z-ai/glm-5.3");
  });

  it("does not retry 4xx and opens the circuit after repeated failures", async () => {
    const { local, config } = await two();
    let t = 1_000;
    const r = Router.fromConfig(config, { ...quiet, env: {}, now: () => t, breaker: { failures: 2, cooldownMs: 5_000 } });
    await r.discover();
    local.failNext(100, 400);
    await r.call(chat()); // spark 400 (no retry) → nearai
    expect(local.hits.filter((h) => h.path === "/v1/chat/completions")).toHaveLength(1);
    await r.call(chat()); // second failure opens the circuit
    const before = local.hits.length;
    expect((await r.call(chat())).endpointId).toBe("nearai");
    expect(local.hits.length).toBe(before); // skipped while open
    t += 6_000;
    local.failNext(0);
    expect((await r.call(chat())).endpointId).toBe("spark");
  });

  it("records live envelopes and replays them with no network", async () => {
    const { config } = await two();
    const dir = mkdtempSync(join(tmpdir(), "replay-"));
    const live = Router.fromConfig(config, { ...quiet, env: {}, record: new ReplayStore(dir) });
    await live.discover();
    const original = await live.call(chat());

    const replay = Router.fromConfig({
      endpoints: [{ id: "replay", adapter: "replay", base_url: dir, privacy_tier: "local", capabilities: ["chat"] }],
      routing: { chat: ["replay"], private_data_allowed_tiers: ["tee", "local"] },
      models: config.models,
    }, quiet);
    const again = await replay.call(chat());
    expect(again.replayed).toBe(true);
    expect(again.outputHash).toBe(original.outputHash);
    expect(again.requestHash).toBe(original.requestHash);
    await expect(replay.call({ ...chat(), input: { messages: [{ role: "user", content: "other" }] } })).rejects.toBeInstanceOf(NoEndpointError);
  });

  it("rejects bad config and unknown endpoints in routing", () => {
    expect(() => Router.fromConfig({ endpoints: [], routing: {} })).toThrow();
    expect(() => Router.fromConfig({
      endpoints: [{ id: "a", base_url: "http://x", privacy_tier: "local", capabilities: ["chat"] }],
      routing: { chat: ["b"], private_data_allowed_tiers: ["local"] },
    })).toThrow(/unknown endpoint b/);
  });
});
