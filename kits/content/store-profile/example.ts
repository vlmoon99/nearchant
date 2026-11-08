// Run: npx tsx example.ts [photo.jpg …]
// Live when OPENAI_BASE_URL, MODEL (and OPENAI_API_KEY if the endpoint needs one) are set; a vision model is needed
// for photos. Otherwise it runs on a canned fake answer and says so.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { analyzeStore, openAiAsk, type Ask } from "./src/index.js";

const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env;
const live = Boolean(OPENAI_BASE_URL && MODEL);

const canned: Ask = async () => JSON.stringify({
  business_name: "Wick & Clay", summary: "Hand-poured soy candles in ceramic cups for people who like quiet evenings",
  customers: "Women 25–45 buying for themselves or as gifts", tone: "calm, warm, unhurried",
  best_days: ["Thursday", "Sunday"], brand_colors: ["#d9c7b0", "#3b3a36"],
  products: [{ name: "Ceramic cup candle", photo: 1, description: "cream glaze cup, soft flame", category: "candles" }],
  content_pillars: ["slow evenings", "how it's made", "gift ideas"], visual_style: "warm low light, linen, wood",
  best_post_hint: "A lit candle at dusk with steam from a mug beside it", avoid: ["loud sale banners"],
});

const ask = live ? openAiAsk({ baseUrl: OPENAI_BASE_URL!, apiKey: OPENAI_API_KEY, model: MODEL! }) : canned;
console.log(live ? `Live: ${MODEL} at ${OPENAI_BASE_URL}` : "No OPENAI_BASE_URL/MODEL set: using a canned fake answer (no network).");

const mime: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const photos = process.argv.slice(2).map((f) => `data:${mime[extname(f).toLowerCase()] ?? "image/jpeg"};base64,${readFileSync(f).toString("base64")}`);

const { profile, facts, photosUsed } = await analyzeStore(ask, {
  name: "Wick & Clay", kind: "handmade candles",
  description: "Small studio pouring soy candles into cups we throw ourselves. Scents: fig, cedar, sea salt.",
}, photos);

console.log(`\nPhotos sent: ${photosUsed}`);
console.log("Facts:");
for (const f of facts) console.log(`  · ${f.title}: ${f.detail}`);
console.log("\nProfile:", JSON.stringify(profile, null, 2));
