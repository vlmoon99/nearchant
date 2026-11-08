// Run: npx tsx example.ts
// Live when OPENAI_BASE_URL and MODEL (and OPENAI_API_KEY if needed) are set: a chat model judges the captions.
// Set DECIDE_MODEL too (e.g. levanto/sage-2 with OPENAI_BASE_URL=https://cloud-api.near.ai/v1) to use NEAR AI's
// decision endpoint instead. Otherwise a canned fake judge answers (no network) and the example says so.
import { chatDecider, checkCaption, nearAiDecider, openAiAsk, storeFactsText, type Ask } from "./src/index.js";

const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL, DECIDE_MODEL } = process.env;

// The fake flags captions that mention an offer word; a real model reads meaning, not keywords.
const canned: Ask = async (messages) => {
  const caption = String(messages[1]?.content ?? "").split("<caption>")[1]?.split("</caption>")[0] ?? "";
  const offer = /% off|free|gift|today only|last \d|sale/i.exec(caption);
  return JSON.stringify(offer ? { probability: 0.93, reason: `"${offer[0]}" is not in the store's facts` } : { probability: 0.04, reason: "describes the item only" });
};

const decide = OPENAI_BASE_URL && DECIDE_MODEL ? nearAiDecider({ baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY, model: DECIDE_MODEL })
  : OPENAI_BASE_URL && MODEL ? chatDecider(openAiAsk({ baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY, model: MODEL }), { model: MODEL })
  : chatDecider(canned, { model: "canned-fake" });
console.log(OPENAI_BASE_URL && (DECIDE_MODEL || MODEL) ? `Live: ${DECIDE_MODEL ?? MODEL} at ${OPENAI_BASE_URL}` : "No OPENAI_BASE_URL/MODEL set: using a canned fake judge (no network).");

const storeFacts = storeFactsText({
  name: "Wick & Clay", description: "Hand-poured soy candles in ceramic cups we throw ourselves.",
  items: [{ title: "Fig cup candle", price: "28 USD" }, { title: "Cedar travel tin", price: "14 USD" }],
});

for (const caption of [
  "Sunday evening, one small flame. Our fig cup candle is poured by hand. Find it in our store.",
  "20% off the fig candle this weekend only — free delivery too!",
]) {
  const r = await checkCaption(decide, { caption, storeFacts });
  console.log(`\n${r.flagged ? "FLAGGED" : "ok     "} ${r.invented_offer.toFixed(2)}  ${caption}`);
  console.log(`        model ${r.model} · ${r.ms} ms · answer ${r.answer_hash.slice(0, 12)}…${r.reason ? ` · ${r.reason}` : ""}`);
}
