// Run: npx tsx example.ts
// Live model when OPENAI_BASE_URL and MODEL (and OPENAI_API_KEY if needed) are set; otherwise a canned fake model
// answers (no network) and the example says so. The web search here is always a canned stand-in: plug in your own
// (Brave, Tavily, SearXNG…) as `search`.
import { findOpportunities, openAiAsk, type Ask, type Search, type StyleProfile } from "./src/index.js";

const { OPENAI_BASE_URL, OPENAI_API_KEY, MODEL } = process.env;
const live = Boolean(OPENAI_BASE_URL && MODEL);

const canned: Ask = async () => JSON.stringify({ opportunities: [
  { kind: "trend", title: "Candles are going viral", why: "Everyone loves candles.", action: "Post more", estimate_usd_month: 400, confidence: "high", source: "https://made-up.example/viral" },
  { kind: "trend", title: "Fig scents are in this autumn", why: "The search result says fig is the season's most-saved candle scent.", action: "Post the fig cup candle on Thursday evening", estimate_usd_month: 120, confidence: "medium", source: "https://example.com/autumn-candle-scents" },
  { kind: "upsell", title: "Cup candle + travel tin", why: "Both are in the store; buyers of a home candle often want one to carry.", action: "Show both side by side in one post", estimate_usd_month: 60, confidence: "low", source: "profile" },
] });

const search: Search = async (q) => [{ title: `Autumn candle scents (${q})`, url: "https://example.com/autumn-candle-scents", snippet: "Fig and cedar lead saves this season." }];

const ask = live ? openAiAsk({ baseUrl: OPENAI_BASE_URL!, apiKey: OPENAI_API_KEY, model: MODEL! }) : canned;
console.log(live ? `Live: ${MODEL} at ${OPENAI_BASE_URL} (search is a canned stand-in)` : "No OPENAI_BASE_URL/MODEL set: using a canned fake model and search (no network).");

const profile: StyleProfile = {
  business_name: "Wick & Clay", summary: "Hand-poured soy candles in ceramic cups", customers: "Women 25–45",
  products: [{ name: "Fig cup candle", category: "candles" }, { name: "Cedar travel tin", category: "candles" }],
};

const { opportunities, searched, dropped } = await findOpportunities(ask, {
  profile, search, place: "Lisbon",
  items: [{ title: "Fig cup candle", price: "28 USD" }, { title: "Cedar travel tin", price: "14 USD" }],
});

console.log(`\nWeb results the model saw: ${searched}`);
for (const o of opportunities) console.log(`  · [${o.kind}] ${o.title} — ~${o.estimate_usd_month} USD/month (estimate, ${o.confidence} confidence)\n      why: ${o.why}\n      do:  ${o.action}\n      source: ${o.source}`);
for (const d of dropped) console.log(`  ✗ dropped "${d.title}" (${d.kind}): ${d.reason}`);
