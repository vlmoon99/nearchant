// One product picture: the seller's real photo restyled into a new scene (or painted from text when there is no
// photo), with no lettering in it; optionally checked by a vision model and drawn again when it has some.
import { ComfyError, fillWorkflow, needsPhoto, type ComfyClient, type Workflow } from "./comfy.js";
import { checkNoText, NO_TEXT } from "./no-text.js";
import type { Ask } from "./openai-ask.js";

export interface ProductImageOptions {
  comfy: ComfyClient;
  /** A workflow template, e.g. WORKFLOWS.qwen_edit (needs a photo) or WORKFLOWS.qwen_t2i (no photo). */
  workflow: Workflow;
  /** The scene, e.g. "the mug on a sunlit wooden café table, morning light, shallow depth of field". */
  prompt: string;
  /** The real product photo (PNG/JPEG bytes). Required when the workflow has a __REF__ input. */
  photo?: Uint8Array | null;
  /** "<node>.<input>" overrides (see VARIANTS). */
  set?: Record<string, string | number>;
  /** Default 1024 × 1280 (4:5, a feed post). Edit workflows take the photo's own size. */
  width?: number;
  height?: number;
  /** Fixed seed for the first render (re-rolls add 1). Default random. */
  seed?: number;
  /** Append NO_TEXT to the prompt. Default true. */
  noText?: boolean;
  /** Vision model: when given, a picture with lettering is drawn again (up to `rerolls` times). */
  see?: Ask;
  /** Default 1. */
  rerolls?: number;
  onStatus?: (s: string) => void;
}

export interface ProductImage {
  bytes: Uint8Array;
  filename: string;
  seed: number;
  /** How many times it was drawn again because of lettering. */
  rerolled: number;
  /** The last lettering check ("unchecked" without `see`). A re-rolled picture that still has text is kept. */
  lettering: "clean" | "text" | "unknown" | "unchecked";
}

export async function makeProductImage(o: ProductImageOptions): Promise<ProductImage> {
  if (needsPhoto(o.workflow) && !o.photo) throw new ComfyError("this workflow edits a photo: pass `photo` (or use a text-to-image workflow)");
  const prompt = o.prompt.trim() + (o.noText === false ? "" : NO_TEXT);
  // Uploaded once; re-rolls reuse it.
  const ref = o.photo && needsPhoto(o.workflow) ? await o.comfy.upload(o.photo, `product-${Date.now().toString(36)}.png`) : undefined;
  const seed0 = o.seed ?? Math.floor(Math.random() * 2 ** 31);
  const render = async (seed: number) => {
    const wf = fillWorkflow(o.workflow, { prompt, seed, width: o.width ?? 1024, height: o.height ?? 1280, ...(ref ? { ref } : {}), ...(o.set ? { set: o.set } : {}) });
    return o.comfy.run(wf, o.onStatus);
  };
  let seed = seed0, out = await render(seed), rerolled = 0;
  let lettering: ProductImage["lettering"] = "unchecked";
  if (o.see) {
    lettering = await checkNoText(o.see, out.bytes);
    for (let i = 0; lettering === "text" && i < (o.rerolls ?? 1); i++) {
      seed += 1; rerolled++;
      o.onStatus?.("lettering found — drawing again");
      out = await render(seed);
      lettering = await checkNoText(o.see, out.bytes);
    }
  }
  return { bytes: out.bytes, filename: out.filename, seed, rerolled, lettering };
}
