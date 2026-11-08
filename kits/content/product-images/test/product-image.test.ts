import { describe, expect, it } from "vitest";
import { checkNoText, ComfyClient, makeProductImage, NO_TEXT, WORKFLOWS, type Ask } from "../src/index.js";
import { fakeComfy } from "./fake-comfy.js";

const fast = { pollIntervalMs: 1, backoffMs: 1 };
const seeSays = (...answers: unknown[]) => {
  let calls = 0;
  const see: Ask = async () => { const a = answers[Math.min(calls++, answers.length - 1)]; if (a instanceof Error) throw a; return a; };
  return { see, calls: () => calls };
};
type Queued = Record<string, { inputs: Record<string, unknown> }>;

describe("makeProductImage", () => {
  it("restyles the photo: uploads it, fills the edit workflow, appends NO_TEXT", async () => {
    const fc = fakeComfy();
    const r = await makeProductImage({ comfy: new ComfyClient({ fetch: fc.fetch, ...fast }), workflow: WORKFLOWS.qwen_edit, prompt: "the mug on a café table ", photo: new Uint8Array([1, 2]), seed: 11 });
    expect(r).toMatchObject({ seed: 11, rerolled: 0, lettering: "unchecked" });
    const wf = fc.queued[0] as Queued;
    expect(wf["6"]!.inputs.prompt).toBe("the mug on a café table" + NO_TEXT);
    expect(wf["41"]!.inputs.image).toBe("photo.png");
    expect(wf["31"]!.inputs.seed).toBe(11);
  });

  it("paints from text with a text-to-image workflow (no upload)", async () => {
    const fc = fakeComfy();
    await makeProductImage({ comfy: new ComfyClient({ fetch: fc.fetch, ...fast }), workflow: WORKFLOWS.qwen_t2i, prompt: "a yoga class at dawn", noText: false, width: 800, height: 1000 });
    expect(fc.calls.some((x) => x.url.includes("/upload/"))).toBe(false);
    expect(JSON.stringify(fc.queued[0])).not.toContain("No text");
    expect(JSON.stringify(fc.queued[0])).toContain('"width":800');
  });

  it("refuses an edit workflow without a photo", async () => {
    await expect(makeProductImage({ comfy: new ComfyClient({ fetch: fakeComfy().fetch }), workflow: WORKFLOWS.qwen_edit, prompt: "x" })).rejects.toThrow(/pass `photo`/);
  });

  it("draws again (new seed, same upload) when the vision check finds lettering", async () => {
    const fc = fakeComfy(), s = seeSays({ has_text: true }, { has_text: false });
    const r = await makeProductImage({ comfy: new ComfyClient({ fetch: fc.fetch, ...fast }), workflow: WORKFLOWS.qwen_edit, prompt: "x", photo: new Uint8Array([1]), seed: 5, see: s.see });
    expect(r).toMatchObject({ seed: 6, rerolled: 1, lettering: "clean" });
    expect(fc.queued).toHaveLength(2);
    expect(fc.calls.filter((x) => x.url.includes("/upload/"))).toHaveLength(1);
  });

  it("stops after `rerolls` and keeps the last picture even if it still has text", async () => {
    const fc = fakeComfy(), s = seeSays({ has_text: true });
    const r = await makeProductImage({ comfy: new ComfyClient({ fetch: fc.fetch, ...fast }), workflow: WORKFLOWS.qwen_t2i, prompt: "x", see: s.see, rerolls: 2 });
    expect(r).toMatchObject({ rerolled: 2, lettering: "text" });
    expect(fc.queued).toHaveLength(3);
  });

  it("a failed or nonsense check does not cost a render", async () => {
    const fc = fakeComfy();
    const r = await makeProductImage({ comfy: new ComfyClient({ fetch: fc.fetch, ...fast }), workflow: WORKFLOWS.qwen_t2i, prompt: "x", see: seeSays(new Error("vision down")).see });
    expect(r).toMatchObject({ rerolled: 0, lettering: "unknown" });
    expect(fc.queued).toHaveLength(1);
  });
});

describe("checkNoText", () => {
  it("reads has_text strictly", async () => {
    expect(await checkNoText(seeSays({ has_text: false }).see, new Uint8Array([1]))).toBe("clean");
    expect(await checkNoText(seeSays({ has_text: true }).see, "data:image/png;base64,AA")).toBe("text");
    expect(await checkNoText(seeSays({ has_text: "yes" }).see, new Uint8Array([1]))).toBe("unknown");
    expect(await checkNoText(seeSays(null).see, new Uint8Array([1]))).toBe("unknown");
  });
  it("sends the picture to the vision model", async () => {
    let images: unknown[] = [];
    await checkNoText(async (i) => { images = i.images ?? []; return { has_text: false }; }, new Uint8Array([7]));
    expect(images).toHaveLength(1);
  });
});
