# Sales ideas

Ideas for a small store to sell more next month — a trend, a price, a bundle, a channel — each with an honest
monthly estimate. A trend is kept only when it rests on a real web result your search returned.

## Copy it

```sh
cp -r kits/content/sales-ideas ./sales-ideas
npm i -D typescript vitest @types/node tsx   # no runtime dependencies
```

```ts
import { findOpportunities, marketQueries, openAiAsk } from "./sales-ideas/src/index.js";
```

## Use it

```ts
const ask = openAiAsk({ baseUrl: "https://cloud-api.near.ai/v1", apiKey: process.env.NEARAI_API_KEY, model: process.env.MODEL! });

// Your web search: Brave, Tavily, SearXNG, Google CSE … → [{ title, url, snippet }]
const search = async (q: string) => (await myBrave(q)).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));

const { opportunities, searched, dropped } = await findOpportunities(ask, {
  profile,                                              // a StyleProfile, e.g. from the store-profile kit
  items: [{ title: "Fig cup candle", price: "28 USD" }],
  search, place: "Lisbon",
});
// [{ kind: "trend", title, why, action, estimate_usd_month: 120, confidence: "medium", source: "https://…" }, …]
// dropped: [{ title: "Candles are going viral", kind: "trend", reason: "trend without a real source" }]
```

Show estimates as estimates ("~120 USD/month, estimate"), never as promises. `npx tsx example.ts` runs it: live
model when `OPENAI_BASE_URL` and `MODEL` are set, otherwise a canned one; the search there is always a canned
stand-in.

## Options

`findOpportunities(ask, input, options?)`

| Input / option | Default | What it does |
| --- | --- | --- |
| `profile` | — | `business_name`, `products[{ name, category? }]`, anything else is passed as context |
| `items` | `[]` | The store's prices; without them a price idea is dropped |
| `search` | — | Without it (or when it fails) no trend is kept, unless `demand` backs it |
| `place` | `""` | Anchors the searches ("linen trend 2026 Lisbon") |
| `demand` | `[]` | `[{ goods, searches, empty }]`: real shopper searches in your marketplace; a trend may cite them |
| `now` | now | Year in the queries |
| `maxEstimate` | `1000` | Estimates are rounded and clamped to 0…this (USD/month) |
| `demandSource` | `"shopper-searches"` | The `source` a demand-backed trend must cite |
| `resultsPerQuery` / `maxResults` | `5` / `12` | How many web results the model sees |
| `searchTimeoutMs` | `15000` | Per search; slow or failing = no results |
| `prompt`, `temperature`, `maxTokens`, `signal` | `OPPORTUNITY_PROMPT`, `0.4`, `2500` | Model call (the shared `RULES` are always appended) |

`marketQueries(profile, { place?, now?, max = 3 })` returns the queries on their own.

## How it works

```
profile ─► marketQueries ─► your search (timeout, errors → []) ─► only http(s) results kept
   │                                                                     │
   └────────── profile + items + results + demand (data blocks) ─► model ─► JSON
                                                                           │
                         code keeps an idea only if: known kind · title and evidence · one per kind ·
                         numeric estimate (clamped) · trend source ∈ returned URLs (or demand) · price ⇒ store has prices
```

- The prompt asks for cautious estimates (usually 30–300 USD/month for a small store), "an estimate, not a
  promise", and to skip a kind rather than guess. The code enforces what the prompt cannot: a trend citing a URL
  the search never returned is dropped, so the model cannot invent one.
- A missing or non-numeric estimate drops the idea (it is not shown as "0 USD").
- Channel ideas are places to share the store's posts; buyers still order in the store, never in DMs or by bank
  transfer.

## Tested

`npx vitest run`: 19 tests, no network. Queries; one idea per kind; estimate clamping, rounding, negatives and
non-numeric estimates; trends dropped without a source, with a made-up source, with no search, with a failing or
hanging search; malformed search results (non-http URLs, nulls); price ideas only with prices; trends backed by
shopper demand (and not without it); unknown kinds; retry then failure on malformed model output; the shared
adapter (retries, timeouts, JSON).
Not tested: a live model or search, and how accurate the estimates are (they are cautious guesses by design).

## Came from

Nearchant's "Ways to sell more" screen: `findOpportunities` and `marketQueries` in
`packages/swarm/src/content.ts` with the `opportunity-analyst` prompt in `envs/content-store/prompts/`, run by the
`find_opportunities` job in `apps/worker/src/content-tasks.ts` (with shopper searches from the Nearchant shop feed
as demand). The chosen idea is passed to the post-writer kit as `opportunity`.
