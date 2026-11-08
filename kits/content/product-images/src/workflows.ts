// The workflow templates Nearchant runs on Comfy Cloud (exported from ComfyUI in API format) and the tested
// variants: the same template with a few "<node>.<input>" overrides. Model files must exist on your ComfyUI.
import qwenEdit from "./workflows/qwen_edit.json" with { type: "json" };
import qwenT2i from "./workflows/qwen_t2i.json" with { type: "json" };
import flux2Edit from "./workflows/flux2_edit.json" with { type: "json" };
import wan22I2v from "./workflows/wan22_i2v14b_l4.json" with { type: "json" };
import wan22Ti2v from "./workflows/wan22_ti2v.json" with { type: "json" };
import type { Workflow } from "./comfy.js";

export const WORKFLOWS = {
  /** Qwen-Image-Edit 2511 + Lightning 4-step LoRA: the product photo in a new scene (Nearchant's default). */
  qwen_edit: qwenEdit as Workflow,
  /** Qwen-Image 2512 text-to-image: no photo (a post about a service, or no product photo yet). */
  qwen_t2i: qwenT2i as Workflow,
  /** FLUX.2 Klein 4B edit (Apache-2.0). */
  flux2_edit: flux2Edit as Workflow,
  /** Wan 2.2 I2V A14B + Lightning 4-step: a 5 s clip from a picture (used for shorts). Output is WEBM. */
  wan22_i2v14b_l4: wan22I2v as Workflow,
  /** Wan 2.2 TI2V 5B: a 5 s clip, 20 steps. */
  wan22_ti2v: wan22Ti2v as Workflow,
} as const;
export type WorkflowName = keyof typeof WORKFLOWS;

export interface Variant { id: string; label: string; workflow: WorkflowName; needsPhoto: boolean; set?: Record<string, string | number>; output: "image" | "video" }

/** The variants compared in Nearchant's admin image lab (config/image-lab.yaml). */
export const VARIANTS: Variant[] = [
  { id: "qie2511-l4", label: "Qwen-Image-Edit 2511 · Lightning 4 steps (default)", workflow: "qwen_edit", needsPhoto: true, output: "image" },
  { id: "qie2511-l8", label: "Qwen-Image-Edit 2511 · Lightning 8 steps", workflow: "qwen_edit", needsPhoto: true, output: "image", set: { "29.lora_name": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors", "31.steps": 8 } },
  { id: "qie2511-full", label: "Qwen-Image-Edit 2511 · full quality (20 steps)", workflow: "qwen_edit", needsPhoto: true, output: "image", set: { "29.strength_model": 0.0, "31.steps": 20, "31.cfg": 4.0 } },
  { id: "qie2509-l4", label: "Qwen-Image-Edit 2509 · Lightning 4 steps", workflow: "qwen_edit", needsPhoto: true, output: "image", set: { "30.unet_name": "qwen_image_edit_2509_fp8mixed.safetensors", "29.lora_name": "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors" } },
  { id: "qi2512-l4", label: "Qwen-Image 2512 text-to-image · Lightning 4 steps (no photo)", workflow: "qwen_t2i", needsPhoto: false, output: "image" },
  { id: "qi2512-turbo2", label: "Qwen-Image 2512 text-to-image · Turbo 2 steps", workflow: "qwen_t2i", needsPhoto: false, output: "image", set: { "2.lora_name": "Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors", "9.steps": 2 } },
  { id: "flux2-klein4b", label: "FLUX.2 Klein 4B · edit, 4 steps (Apache-2.0)", workflow: "flux2_edit", needsPhoto: true, output: "image" },
  { id: "flux2-klein4b-base", label: "FLUX.2 Klein 4B base · edit, 24 steps (Apache-2.0)", workflow: "flux2_edit", needsPhoto: true, output: "image", set: { "1.unet_name": "flux-2-klein-base-4b.safetensors", "13.steps": 24, "10.cfg": 3.5 } },
  { id: "wan22-i2v14b-l4", label: "VIDEO · Wan 2.2 I2V A14B + Lightning 4-step · 5 s from the picture", workflow: "wan22_i2v14b_l4", needsPhoto: true, output: "video" },
  { id: "wan22-ti2v5b", label: "VIDEO · Wan 2.2 TI2V 5B · 5 s from the picture, 20 steps", workflow: "wan22_ti2v", needsPhoto: true, output: "video" },
];

/** A variant's template and overrides by id. */
export function variant(id: string): { workflow: Workflow; set: Record<string, string | number>; needsPhoto: boolean } {
  const v = VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`unknown variant ${id} (have: ${VARIANTS.map((x) => x.id).join(", ")})`);
  return { workflow: WORKFLOWS[v.workflow], set: v.set ?? {}, needsPhoto: v.needsPhoto };
}
