# Post writer

Write social posts in a store's own voice: several caption options to choose from, one-tap rewrites (shorter,
playful, bolder, custom, fix), a memory of what the owner likes, and 6–10 s video scripts — without invented offers.

## Copy it

```sh
cp -r kits/content/post-writer ./post-writer
npm i -D typescript vitest @types/node tsx   # no runtime dependencies
```

```ts
import { writePostOptions, rewriteCaption, learnTaste, writeVideoScript, openAiAsk } from "./post-writer/src/index.js";
```

## Use it

```ts
const ask = openAiAsk({ baseUrl: "https://cloud-api.near.ai/v1", apiKey: process.env.NEARAI_API_KEY, model: process.env.MODEL! });

// profile: a StyleProfile, e.g. from the store-profile kit
const posts = await writePostOptions(ask, { profile, n: 3, about: "posts for a rainy weekend", memory });
// [{ angle, product, photo, audience, caption, headline, hashtags, image_prompt }, …]

const shorter = await rewriteCaption(ask, { profile, caption: posts[0].caption, style: "shorter" });
const fixed = await rewriteCaption(ask, { profile, caption, style: "fix", instruction: "promises a discount the store never stated" });

memory = await learnTaste(ask, memory, [
  { kind: "picked", data: { angle: posts[0].angle } },
  { kind: "passed", data: { angle: posts[1].angle } },
  { kind: "rewrote", data: { before: posts[0].caption, after: "my own words" } },
]);

const video = await writeVideoScript(ask, { profile, caption: shorter, angle: posts[0].angle });
// { hook: "Your quiet hour", voiceover: "…no digits, ≤ 22 words…", video_prompt: "camera-only motion" }
```

`npx tsx example.ts` runs all four: live when `OPENAI_BASE_URL` and `MODEL` (and `OPENAI_API_KEY`) are set,
otherwise on canned answers, and it says which.

## Options

| Function / option | Default | What it does |
| --- | --- | --- |
| `writePostOptions` `n` | `3` (1–10) | How many options |
| `photoCount` | highest photo number in the profile | Photo numbers above it become `null` |
| `memory`, `recentPicks`, `passedAngles` | — | The owner's taste outweighs the profile; passed angles are not repeated; one option tries something new |
| `opportunity` | — | `{ kind, title, why, action? }` every option serves (e.g. from the sales-ideas kit) |
| `about` | — | The owner's request for this batch (a data block, capped at 500 chars) |
| `today` | today | `YYYY-MM-DD`, for seasonal angles |
| option `ctaRule` | `STORE_CTA_RULE` | Where buyers order ("in our store", "link in bio"; never DMs or bank transfer). Your own text, or `""` |
| `rewriteCaption` `style` | — | `shorter` · `playful` · `bolder` · `custom` (with `instruction`) · `fix` (with `instruction` = why it was flagged) |
| `learnTaste` option `maxEvents` | `60` | Only the latest events are sent |
| `writeVideoScript` option `maxWords` | `22` | Voiceover length (≈ 8–9 s of speech) |
| every function: `prompt`, `temperature`, `maxTokens`, `signal` | per step | Replace the prompt (the shared `RULES` are still appended) or model settings |

`profile.wishes` (a string set by the owner) is followed in every option and image prompt.

## How it works

Each function is one model call through `askJson`: the profile, memory and owner text go in tagged data blocks,
the reply is parsed and shaped in code, and a bad reply gets one retry with the error before it throws.

- Shaping: captions required (posts without one are dropped), photo numbers checked, `#` and spaces removed from
  hashtags, headline cut to 5 words, memory lists capped at 8 strings.
- Honesty: every prompt ends with `RULES` — never invent prices, reviews or offers (no discounts, free delivery,
  gifts, deadlines, limited stock); a bundle means "these go well together". Rewrites keep every fact and add none.
- Video: sentences with digits are removed from the voiceover (TTS reads numbers badly and they are the claims most
  often made up), whole sentences are kept up to `maxWords`, and a motion prompt that brings hands or people into
  the frame is replaced with `CAMERA_ONLY` (fast video models ignore negative prompts).

## Tested

`npx vitest run`: 20 tests on a fake `ask` / fake `fetch` (no network). Data blocks and rules in the prompts, owner
text staying inside its block, empty memory left out, replaceable CTA rule, post shaping (photo numbers, hashtags,
headline, `caption_en` fallback), retry then failure on bad output; rewrite instructions as data, unknown style and
empty caption rejected before any call; taste memory caps and the event window; voiceover number removal and
length, camera-only replacement, retry on an empty voiceover; the shared adapter (retries, timeouts, JSON).
Not tested: a live model, the writing quality.

## Came from

Nearchant's content store: `packages/swarm/src/content.ts` (`writePostOptions`, `rewriteCaption`, `learnTaste`,
`writeVideoScript`, `shortVoiceover`) with the `idea-writer`, `caption-editor`, `learner` and `video-director`
prompts in `envs/content-store/prompts/`, run by the `generate_posts`, `rewrite_caption`, `learn_taste` and
`make_video` jobs in `apps/worker/src/content-tasks.ts`. Nearchant runs `learn_taste` a minute after each batch,
once at least 3 new signals exist.
