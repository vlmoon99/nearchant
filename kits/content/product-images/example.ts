// Puts your product photo into a new scene on ComfyUI.
//   COMFY_API_KEY=… npx tsx example.ts photo.png "the mug on a sunlit wooden café table, morning light"
//   COMFY_URL=http://127.0.0.1:8188 COMFY_API=comfyui npx tsx example.ts photo.png "…"      (self-hosted ComfyUI)
// Optional lettering check with a vision model: AI_BASE_URL, AI_MODEL, AI_API_KEY (any OpenAI-compatible endpoint).
// Optional VARIANT=<id> (see VARIANTS in src/workflows.ts); without a photo the text-to-image workflow is used.
import { readFile, writeFile } from "node:fs/promises";
import { ComfyClient, makeProductImage, openaiAsk, variant, VARIANTS } from "./src/index.js";

const [photoPath, prompt = "the product on a sunlit wooden table in a cosy café, morning light, shallow depth of field"] = process.argv.slice(2);
const key = process.env.COMFY_API_KEY, url = process.env.COMFY_URL;
if (!key && !url) {
  console.log("Set COMFY_API_KEY (Comfy Cloud) or COMFY_URL + COMFY_API=comfyui (your own ComfyUI) to run this live.\n" +
    "Usage: npx tsx example.ts [photo.png] [scene prompt]\n\nVariants you can pick with VARIANT=<id>:");
  for (const v of VARIANTS) console.log(`  ${v.id.padEnd(20)} ${v.label}`);
  process.exit(0);
}
const comfy = new ComfyClient({ ...(key ? { apiKey: key } : {}), ...(url ? { baseUrl: url } : {}), api: process.env.COMFY_API === "comfyui" ? "comfyui" : "cloud" });
const v = variant(process.env.VARIANT ?? (photoPath ? "qie2511-l4" : "qi2512-l4"));
const see = process.env.AI_BASE_URL && process.env.AI_MODEL
  ? openaiAsk({ baseUrl: process.env.AI_BASE_URL, model: process.env.AI_MODEL, ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}) }) : undefined;

const t0 = Date.now();
const r = await makeProductImage({
  comfy, workflow: v.workflow, set: v.set, prompt,
  ...(photoPath ? { photo: new Uint8Array(await readFile(photoPath)) } : {}),
  ...(see ? { see } : {}),
  onStatus: (s) => console.log(`  ${s}`),
});
const out = `product-${r.seed}.${r.filename.split(".").pop() ?? "png"}`;
await writeFile(out, r.bytes);
console.log(`wrote ${out} in ${Math.round((Date.now() - t0) / 1000)} s — lettering: ${r.lettering}, re-rolled ${r.rerolled}×`);
