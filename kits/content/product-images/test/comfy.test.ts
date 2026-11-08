import { describe, expect, it } from "vitest";
import { ComfyClient, ComfyError, fillWorkflow, needsPhoto, variant, VARIANTS, WORKFLOWS, type Workflow } from "../src/index.js";
import { fakeComfy } from "./fake-comfy.js";

const fast = { pollIntervalMs: 1, backoffMs: 1 };

describe("fillWorkflow", () => {
  const t: Workflow = { "1": { class_type: "LoadImage", inputs: { image: "__REF__" } }, "2": { class_type: "KSampler", inputs: { seed: "__SEED__", steps: 4, text: "__PROMPT__", w: "__WIDTH__", h: "__HEIGHT__" } } };
  it("fills placeholders and applies overrides without touching the template", () => {
    const wf = fillWorkflow(t, { prompt: "a mug", ref: "photo.png", seed: 7, width: 1024, height: 1280, set: { "2.steps": 8 } });
    expect(wf["1"]!.inputs.image).toBe("photo.png");
    expect(wf["2"]!.inputs).toEqual({ seed: 7, steps: 8, text: "a mug", w: 1024, h: 1280 });
    expect(t["2"]!.inputs.seed).toBe("__SEED__");
  });
  it("rejects an override for a missing node", () => {
    expect(() => fillWorkflow(t, { prompt: "", seed: 1, width: 1, height: 1, set: { "99.steps": 1 } })).toThrow(/no node 99/);
  });
  it("knows which workflows need a photo", () => {
    expect(needsPhoto(WORKFLOWS.qwen_edit)).toBe(true);
    expect(needsPhoto(WORKFLOWS.qwen_t2i)).toBe(false);
  });
  it("every shipped variant applies cleanly to its template and has a prompt and a seed", () => {
    for (const v of VARIANTS) {
      const { workflow, set, needsPhoto: np } = variant(v.id);
      const wf = JSON.stringify(fillWorkflow(workflow, { prompt: "P-R-O-M-P-T", ref: "R-E-F", seed: 4242, width: 1024, height: 1280, set }));
      expect(wf, v.id).toContain("P-R-O-M-P-T");
      expect(wf, v.id).toContain("4242");
      expect(wf.includes("R-E-F"), v.id).toBe(np);
      expect(wf, v.id).not.toMatch(/__[A-Z]+__/);
    }
    expect(() => variant("nope")).toThrow(/unknown variant/);
  });
});

describe("ComfyClient — Comfy Cloud", () => {
  it("uploads, queues, polls, follows the signed link without the key", async () => {
    const fc = fakeComfy({ running: 2, output: new Uint8Array([9, 9]) });
    const c = new ComfyClient({ apiKey: "KEY", fetch: fc.fetch, ...fast });
    expect(await c.upload(new Uint8Array([1]), "a.png")).toBe("photo.png");
    const statuses: string[] = [];
    const out = await c.run(WORKFLOWS.qwen_t2i, (s) => statuses.push(s));
    expect([...out.bytes]).toEqual([9, 9]);
    expect(out.filename).toBe("out.png");
    expect(statuses).toContain("running");
    const api = fc.calls.filter((x) => x.url.startsWith("https://cloud.comfy.org/api"));
    expect(api.every((x) => x.headers["X-API-Key"] === "KEY")).toBe(true);
    const signed = fc.calls.find((x) => x.url.startsWith("https://signed.example"))!;
    expect(signed.headers["X-API-Key"]).toBeUndefined();
  });

  it("explains a 402 in plain words and does not retry queueing", async () => {
    const fc = fakeComfy({ fail: { "/api/prompt": [new Response("{}", { status: 402 })] } });
    const err = await new ComfyClient({ apiKey: "k", fetch: fc.fetch, ...fast }).run(WORKFLOWS.qwen_t2i).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyError);
    expect(err.message).toMatch(/out of credits/);
    expect(fc.calls.filter((x) => x.url.endsWith("/prompt"))).toHaveLength(1);
  });

  it("does not retry a 500 on queue by default (a retry may bill twice), but can be told to", async () => {
    const one = fakeComfy({ fail: { "/api/prompt": [new Response("{}", { status: 500 })] } });
    await expect(new ComfyClient({ fetch: one.fetch, ...fast }).queue({})).rejects.toThrow(/HTTP 500/);
    const two = fakeComfy({ fail: { "/api/prompt": [new Response("{}", { status: 500 })] } });
    expect(await new ComfyClient({ fetch: two.fetch, queueRetries: 1, ...fast }).queue({})).toBe("p1");
  });

  it("retries a failed upload (safe: overwrite) and a failed download", async () => {
    const fc = fakeComfy({ fail: { "/api/upload": [new Response("x", { status: 503 }), new Error("ECONNRESET")], "/api/view": [new Response("x", { status: 502 })] } });
    const c = new ComfyClient({ fetch: fc.fetch, ...fast });
    expect(await c.upload(new Uint8Array([1]), "a.png")).toBe("photo.png");
    expect((await c.run({})).bytes.length).toBe(3);
  });

  it("does not retry a 401 upload", async () => {
    const fc = fakeComfy({ fail: { "/api/upload": [new Response("x", { status: 401 })] } });
    await expect(new ComfyClient({ fetch: fc.fetch, ...fast }).upload(new Uint8Array([1]), "a.png")).rejects.toThrow(/key is wrong/);
    expect(fc.calls).toHaveLength(1);
  });

  it("rides out status-check errors while polling", async () => {
    const fc = fakeComfy({ running: 1, fail: { "/api/job/": [new Error("timeout"), new Response("x", { status: 500 })] } });
    expect((await new ComfyClient({ fetch: fc.fetch, ...fast }).run({})).filename).toBe("out.png");
  });

  it("fails when the job ends badly", async () => {
    const fc = fakeComfy({ final: "error" });
    await expect(new ComfyClient({ fetch: fc.fetch, ...fast }).run({})).rejects.toThrow(/job ended as error/);
  });

  it("gives up after maxWaitMs", async () => {
    const fc = fakeComfy({ running: 1e9 });
    await expect(new ComfyClient({ fetch: fc.fetch, ...fast, maxWaitMs: 30 }).run({})).rejects.toThrow(/timed out/);
  });
});

describe("ComfyClient — self-hosted ComfyUI", () => {
  it("polls /history and downloads /view directly", async () => {
    const fc = fakeComfy({ api: "comfyui", running: 1, output: new Uint8Array([5]) });
    const c = new ComfyClient({ baseUrl: "http://gpu:8188/", api: "comfyui", fetch: fc.fetch, ...fast });
    const out = await c.run({});
    expect([...out.bytes]).toEqual([5]);
    expect(fc.calls.some((x) => x.url === "http://gpu:8188/history/p1")).toBe(true);
    expect(fc.calls.every((x) => !("X-API-Key" in x.headers))).toBe(true);
  });
  it("reports a failed job", async () => {
    const fc = fakeComfy({ api: "comfyui", final: "error" });
    await expect(new ComfyClient({ baseUrl: "http://gpu:8188", api: "comfyui", fetch: fc.fetch, ...fast }).run({})).rejects.toThrow(/job failed/);
  });
});
