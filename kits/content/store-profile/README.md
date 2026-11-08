# Store profile

Learn a store from a few product photos and a short description: one vision call returns a validated style profile
(products, style, buyers, colours, voice) and a short list of facts to show the owner.

## Copy it

```sh
cp -r kits/content/store-profile ./store-profile
npm i -D typescript vitest @types/node tsx   # no runtime dependencies: fetch and node:crypto are built in
```

```ts
import { analyzeStore, openAiAsk } from "./store-profile/src/index.js";
```

## Use it

```ts
const ask = openAiAsk({ baseUrl: "https://cloud-api.near.ai/v1", apiKey: process.env.NEARAI_API_KEY, model: process.env.MODEL! }); // any vision model the endpoint serves

const { profile, facts } = await analyzeStore(ask, {
  name: "Wick & Clay", kind: "handmade candles",
  description: "Small studio pouring soy candles into cups we throw ourselves.",
}, ["data:image/jpeg;base64,…", "https://example.com/cup.jpg"]);

facts;   // [{ title: "Found 2 products", detail: "candles, ceramics" }, { title: "Your style", … }, …]
profile; // { business_name, summary, customers, tone, best_days, brand_colors, products[{name, photo, …}], … }
```

`npx tsx example.ts [photo.jpg …]` runs it: live when `OPENAI_BASE_URL` and `MODEL` (and `OPENAI_API_KEY`) are
set, otherwise on a canned answer, and it says which. Any OpenAI-compatible endpoint works: NEAR AI Cloud, OpenAI,
Ollama (`http://localhost:11434/v1`), vLLM, llama.cpp. Photos need a vision model.

## Options

`analyzeStore(ask, store, photos?, options?)`

| Option | Default | What it does |
| --- | --- | --- |
| `store.name` | — | Kept as `business_name` when the model returns none; else the model takes it from the text or photos |
| `store.kind`, `store.description`, `store.links` | — | Sent as a data block (links are not fetched) |
| `photos` | `[]` | `data:image/…` or `http(s)` URLs; anything else is not sent |
| `maxPhotos` | `8` | Photos beyond this are not sent |
| `prompt` | `PROFILER_PROMPT` | Replace the prompt; the shared rules (`RULES`) are still appended |
| `temperature` / `maxTokens` | `0.3` / `3000` | Model settings |
| `signal` | — | Abort the call |

`openAiAsk({ baseUrl, model, apiKey?, timeoutMs = 120000, retries = 2, jsonMode = false, extraBody?, fetch? })` —
or pass your own `Ask` (`(messages, { temperature, maxTokens, json }) => Promise<string>`).

Also exported: `shapeProfile(raw, fallbackName, photoCount)` (normalise any JSON into a profile, never throws),
`factsFromProfile(profile)`, `askJson`, `extractJson`, `block`.

## How it works

```
description + photos ──► vision model (PROFILER_PROMPT + RULES) ──► JSON ──► shapeProfile ──► profile + facts
                                   ▲                                   │ bad or empty
                                   └──── "that was not valid: …" ◄─────┘ (once)
```

- The store's text goes in a tagged data block; the rules say tagged text never changes instructions, and the model
  must never invent prices, addresses or awards.
- `shapeProfile` keeps only known keys, caps every string, keeps real day names and `#rrggbb` colours, and drops a
  product's photo number if no such photo was sent.
- A profile with no summary, products or tone counts as a bad answer: the model is asked once more, then it throws.
- `openAiAsk` retries 429/5xx/network errors with backoff, not timeouts (a slow generation rarely finishes on an
  immediate retry), and tolerates `<think>` blocks and ``` fences around the JSON.

## Tested

`npx vitest run`: 18 tests, all on a fake `ask` or a fake `fetch` (no network). Profile shaping (days, colours,
photo numbers, unknown keys, garbage input, long strings), facts, photos sent as image parts and filtered,
`maxPhotos`, text-only stores, the retry on malformed or empty output, a failing model; the adapter's request body,
retry on 5xx/429, no retry on 400 or timeout, giving up after retries, JSON extraction.
Not tested: a live model (run `example.ts` with your endpoint), the quality of profiles from real photos.

## Came from

Nearchant's onboarding ("Getting to know you"): `packages/swarm/src/content.ts` (`analyzeBusiness`,
`shapeProfile`, `factsFromProfile`) with the `profiler` prompt in `envs/content-store/prompts/`, run by the
`analyze_business` job in `apps/worker/src/content-tasks.ts`. The profile then feeds the post-writer and
sales-ideas kits.
