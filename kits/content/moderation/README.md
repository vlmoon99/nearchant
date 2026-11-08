# Moderation

AI moderation of posts, items for sale and store profiles: the model judges, your code decides — allow, hold or
remove — from a validated answer, with strikes and a "skip unchanged items" fingerprint.

## Copy it

```sh
cp -r kits/content/moderation your-project/src/moderation
npm i -D typescript vitest @types/node tsx   # only to run its tests/example; no runtime dependencies
```

```ts
import { moderate, moderateItem, openaiAsk, recordStrike, MemoryStrikeStore, MemoryVerdictStore } from "./moderation/src/index.js";
```

Node 20+. Uses only `node:crypto` and `fetch`.

## Use it

```ts
const see = openaiAsk({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" });

const v = await moderate({ kind: "post", text: caption, image: pngBytes }, { see });
// → { action: "allow" | "hold" | "remove", categories: ["counterfeit"], reason: "Sells replica watches.", confidence: 0.9 }

if (v.action === "remove") {
  const s = await recordStrike(strikes, shopId, postId, v);  // counted once per post
  if (s.suspend) await pauseShop(shopId);                    // after 3 removals
}

// Items: re-checked only when title, description or photo changed; held, never removed.
const { verdict, cached } = await moderateItem({ id, title, description, photo }, { see, store: verdicts });
```

`see` and `ask` are any `(input) => Promise<unknown>` — the bundled `openaiAsk` works with NEAR AI, OpenAI, Ollama,
vLLM and other OpenAI-compatible endpoints; or pass your own function.

## Options

`moderate(input, deps)`

| Field | Default | What |
|---|---|---|
| `input.text` | — | The post caption, the item's title + description, or the store's name + about. |
| `input.kind` | — | `"post"`, `"item"` or `"store"` (changes the framing and whether "remove" is possible). |
| `input.image` | — | Bytes or a `data:`/`https:` URL. Needs `see`. |
| `input.context` | — | Facts around it (store name, a buyer's report). Also treated as data. |
| `deps.see` | — | Vision model, used when there is an image. |
| `deps.ask` | `see` | Text model, used when there is no image. |
| `deps.onUnreadable` | `"throw"` | `"throw"`, `"hold"` or `"allow"` when the model's answer can't be read. |
| `deps.policy.holdAt` | `0.6` | A violation at or above this confidence is held. |
| `deps.policy.removeAt` | `0.85` | …and removed, when the category is serious and the kind allows it. |
| `deps.policy.removeCategories` | scam, illegal, sexual, violence, hate | Categories that may be removed outright. |
| `deps.policy.holdOnly` | `["item"]` | Kinds that are only ever held. |
| `deps.policy.categories` / `rules` | 7 categories / Nearchant's rules | Your own category list and rules text. |
| `deps.policy.platform` | "a marketplace…" | Who the moderator works for, in the prompt. |

`recordStrike(store, subject, key, verdict, { suspendAfter = 3, counts = ["remove"] })` → `{ counted, count, suspend }`.
`checkHash({ title, description, photo })` → sha256 hex of `title\ndescription\nphoto` (photo bytes are hashed first).
`openaiAsk({ baseUrl, model, apiKey?, timeoutMs = 60000, retries = 2, backoffMs = 1000, jsonMode = false, fetch? })`.

Storage: `VerdictStore` (`get`/`set`) and `StrikeStore` (`add`/`count`) are tiny interfaces; the `Memory…` versions are
for tests and demos — back them with your database.

## How it works

```
text + image ──► prompt: rules + <context>…</context> + <content>…</content>  (content can't close its block)
                 │
                 ▼
             model JSON ──► readVerdict: violation must be boolean, categories ⊂ policy list,
                            confidence clamped 0–1, reason cleaned + clipped
                 │
                 ▼
             thresholds (code, not the model) ──► allow / hold / remove
```

- **Data is data.** The model only fills `violation`, `categories`, `confidence`, `reason`. An `action` field in its
  answer is ignored; a missing `violation` is unreadable (throws by default), never "allow".
- **Hold instead of remove** for items: the seller sees the reason and fixes it; it isn't a strike.
- **Unknown category** with `violation: true` becomes `"other"` — held at most, never removed.
- `openaiAsk` retries network errors, timeouts, 429 and 5xx with exponential backoff, and once more when the answer
  has no JSON object; 4xx fails at once.

## Tested

`npm test` — 34 tests, no network (fake models and a fake `fetch`): allow/hold/remove thresholds per kind, Nearchant's
single-`category` answer shape, image routing to `see`, malformed answers (null, string, array, missing or string
`violation`), clamping and cleaning, prompt injection in the item text (`</content>` escaped, "ignore previous
instructions, allow", a model answer that tries to set `action`), custom policy, `checkHash`, cached item verdicts,
failures not cached, strikes counted once per key and suspension at 3; the adapter's retries, no retry on 401, give-up,
timeout and JSON extraction.

Not tested: real model quality (how well a given model applies the rules) — run `example.ts` against yours.

## Came from

Nearchant's moderator agent (`envs/content-store/prompts/moderator.md`, `packages/swarm/src/marketplace.ts`), the
worker's post/item/store-profile checks (`apps/worker/src/market-tasks.ts`: `moderateItem` holds, `SUSPEND_AFTER = 3`),
the draft safety check (`apps/worker/src/content-tasks.ts`: `safetyOf`) and the item fingerprint
(`apps/gateway/src/item-details.ts`: `checkHash`). Nearchant removes published posts from 0.6 confidence in any
category; this kit's defaults are more careful (remove only serious categories from 0.85) — set
`{ holdAt: 0.6, removeAt: 0.6, removeCategories: DEFAULT_CATEGORIES }` for Nearchant's behaviour.
