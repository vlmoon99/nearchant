// Run: npx tsx example.ts
// Live when OPENAI_BASE_URL and MODEL (and OPENAI_API_KEY if needed) are set; otherwise a canned fake model answers
// (no network) and the example says so.
import { learnTaste, openAiAsk, rewriteCaption, writePostOptions, writeVideoScript, type Ask, type StyleProfile } from "./src/index.js";

const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env;
const live = Boolean(OPENAI_BASE_URL && MODEL);

// The fake looks at the system prompt to know which step is asking.
const canned: Ask = async (messages) => {
  const system = String(messages[0]?.content ?? "");
  if (system.startsWith("You are the content manager")) return JSON.stringify({ posts: [
    { angle: "Slow Sunday ritual", product: "Cup candle", photo: 1, audience: "people winding down", caption: "Sunday evening, one small flame, nowhere to be. Our fig cup candle is poured by hand in the studio. Find it in our store.", headline: "Your quiet hour", hashtags: ["candles", "slowliving"], image_prompt: "Candle on a linen cloth at dusk, warm window light" },
    { angle: "Behind the scenes", product: "Cup candle", photo: 1, audience: "makers and gift buyers", caption: "Every cup is thrown on our wheel before the wax goes in. Tap to see this week's batch.", headline: "Made twice by hand", hashtags: ["handmade", "ceramics"], image_prompt: "Candle beside clay tools on a wooden bench" },
  ] });
  if (system.startsWith("You edit one")) return JSON.stringify({ caption: "One flame, nowhere to be. Fig cup candle, poured by hand. In our store." });
  if (system.startsWith("You keep the memory")) return JSON.stringify({ likes: ["short, calm captions"], dislikes: ["exclamation marks"], topics: ["fig candle"], voice: "quiet and plain", notes: ["no emoji"] });
  return JSON.stringify({ hook: "Your quiet hour", voiceover: "Slow evenings deserve soft light. Poured by hand in our studio. Tap the link to get yours.", video_prompt: "One slow push-in toward the lit candle as warm light shifts across the linen." });
};

const ask = live ? openAiAsk({ baseUrl: OPENAI_BASE_URL!, apiKey: OPENAI_API_KEY, model: MODEL! }) : canned;
console.log(live ? `Live: ${MODEL} at ${OPENAI_BASE_URL}` : "No OPENAI_BASE_URL/MODEL set: using a canned fake model (no network).");

const profile: StyleProfile = {
  business_name: "Wick & Clay", summary: "Hand-poured soy candles in ceramic cups", customers: "Women 25–45, for themselves or as gifts",
  tone: "calm, warm, unhurried", best_days: ["Thursday", "Sunday"], brand_colors: ["#d9c7b0", "#3b3a36"],
  products: [{ name: "Cup candle", photo: 1, description: "fig scent, cream glaze cup" }],
  content_pillars: ["slow evenings", "how it's made"], visual_style: "warm low light, linen, wood", avoid: ["loud sale banners"],
};

const posts = await writePostOptions(ask, { profile, n: 2, about: "posts for a rainy weekend" });
console.log("\nOptions:");
for (const p of posts) console.log(`  · [${p.angle}] ${p.caption}  #${p.hashtags.join(" #")}`);

const shorter = await rewriteCaption(ask, { profile, caption: posts[0]!.caption, style: "shorter" });
console.log(`\nShorter: ${shorter}`);

const memory = await learnTaste(ask, {}, [
  { kind: "picked", data: { angle: posts[0]!.angle } },
  { kind: "passed", data: { angle: posts[1]?.angle } },
  { kind: "rewrote", data: { before: posts[0]!.caption, after: shorter } },
]);
console.log("\nOwner memory:", JSON.stringify(memory));

const video = await writeVideoScript(ask, { profile, caption: shorter, angle: posts[0]!.angle });
console.log("\nVideo script:", JSON.stringify(video, null, 2));
