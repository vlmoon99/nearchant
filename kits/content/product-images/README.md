# Product images

AI pictures of the seller's real product in new scenes, rendered on ComfyUI (Comfy Cloud or your own), with no
stray lettering: every prompt asks for none, and an optional vision check draws a picture again when it has some.

## Copy it

```sh
cp -r kits/content/product-images your-project/src/product-images
npm i -D typescript vitest @types/node tsx   # only to run its tests/example; no runtime dependencies
```

```ts
import { ComfyClient, makeProductImage, WORKFLOWS, openaiAsk } from "./product-images/src/index.js";
```

Node 20.10+ (the workflow templates are imported as JSON with `with { type: "json" }`).

## Use it

```ts
const comfy = new ComfyClient({ apiKey: process.env.COMFY_API_KEY });            // Comfy Cloud
// const comfy = new ComfyClient({ baseUrl: "http://127.0.0.1:8188", api: "comfyui" }); // self-hosted

const pic = await makeProductImage({
  comfy,
  workflow: WORKFLOWS.qwen_edit,          // Qwen-Image-Edit 2511, 4 steps: keeps the product, changes the scene
  photo: productPngBytes,
  prompt: "the mug on a sunlit wooden café table, morning light, shallow depth of field",
  see: openaiAsk({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" }), // optional
});
// pic.bytes (PNG), pic.lettering: "clean" | "text" | "unknown" | "unchecked", pic.rerolled, pic.seed
```

No product photo (a service, say)? Use `WORKFLOWS.qwen_t2i`. Other tested set-ups: `variant("qie2511-l8")` etc. —
see `VARIANTS` in `src/workflows.ts`. The same client renders 5 s clips with `WORKFLOWS.wan22_i2v14b_l4` (for the
shorts kit).

## Options

`makeProductImage(options)`

| Option | Default | What |
|---|---|---|
| `comfy` | — | A `ComfyClient`. |
| `workflow` | — | A template (`WORKFLOWS.*` or your own, exported from ComfyUI with "Save (API)"). |
| `prompt` | — | The scene. |
| `photo` | — | Product photo bytes; required when the workflow has a `__REF__` input. |
| `set` | — | `"<node>.<input>": value` overrides (steps, LoRA, model file). |
| `width` × `height` | 1024 × 1280 | For text-to-image workflows (edit workflows keep the photo's size). |
| `seed` | random | First seed; each re-roll adds 1. |
| `noText` | `true` | Append `NO_TEXT` ("No text, letters, words, numbers, logos or watermarks…"). |
| `see` | — | Vision function; enables the lettering check. |
| `rerolls` | `1` | How many times a picture with lettering is drawn again. |
| `onStatus` | — | Progress callback. |

`new ComfyClient(options)`

| Option | Default | What |
|---|---|---|
| `baseUrl` | `https://cloud.comfy.org/api` | Or your ComfyUI, e.g. `http://127.0.0.1:8188`. |
| `apiKey` | — | Comfy Cloud key (`X-API-Key`). |
| `api` | `"cloud"` | `"comfyui"` for a self-hosted server (`/history` polling, direct `/view`). |
| `requestTimeoutMs` | 60 000 | Per request. |
| `downloadTimeoutMs` | 120 000 | The final file. |
| `pollIntervalMs` | 2000 | |
| `maxWaitMs` | 600 000 | Give up on a job after 10 min. |
| `retries` / `backoffMs` | 2 / 1000 | For safe calls: upload (overwrite), status, download. |
| `queueRetries` | 0 | Queueing is not idempotent — a retry may run (and bill) the job twice. |

Placeholders in templates: `__PROMPT__`, `__REF__` (the uploaded photo), `__SEED__`, `__WIDTH__`, `__HEIGHT__`.
`checkNoText(see, image)` → `"clean" | "text" | "unknown"` on its own.

## How it works

```
photo ──upload──► ComfyUI ◄──queue── fillWorkflow(template, prompt + NO_TEXT, seed, ref)
                     │ poll status (errors ride out until maxWaitMs)
                     ▼
               first output file ──download (Cloud: signed link, fetched without the key)──► bytes
                     │
            see? ──► "Does this picture contain any text…?" {"has_text": …}
                     └─ text → render again with seed+1 (same upload), up to `rerolls`
```

- Models garble lettering and invent brand labels; text on a post belongs in a strip you draw yourself (see the
  `image-headline` kit). A real label on the product may cost one extra render — acceptable.
- A failed or nonsense vision answer is `"unknown"` and keeps the picture: one bad check shouldn't cost a render.
- Model files named in the templates must exist on your ComfyUI (Comfy Cloud has them). The models are
  Apache-2.0 (Qwen-Image / -Edit, FLUX.2 Klein 4B, Wan 2.2); check their licences for your use. The FLUX.2 Klein 9B
  variant from Nearchant's lab is left out (non-commercial licence).

## Tested

`npm test` — 30 tests, no network (a fake Comfy Cloud / ComfyUI behind a fake `fetch`): placeholder filling and
overrides, every shipped variant against its template, the full Cloud flow (key sent to the API, not to the signed
storage link), plain-language 401/402 errors, no retry of queueing by default (opt-in works), upload and download
retries, status errors ridden out, failed job, the `maxWaitMs` timeout, the self-hosted `/history` flow and its failure;
`makeProductImage` (edit and text-to-image, `NO_TEXT`, missing photo, re-roll with a new seed and one upload, re-roll
limit, failed check), `checkNoText` strictness, and the OpenAI adapter.

Not tested here: a live Comfy Cloud or ComfyUI run, and picture quality (`example.ts` does a live run with your key).
The Comfy Cloud endpoints follow what Nearchant uses in production; the self-hosted path follows the standard ComfyUI
API (`/prompt`, `/history/<id>`, `/view`).

## Came from

Nearchant's Comfy Cloud client (`packages/providers/src/comfy-cloud.ts`), its admin image lab
(`config/image-lab.yaml` + `config/image-lab/*.json` — the templates here), the `NO_TEXT` suffix
(`apps/worker/src/image-text.ts`) and the lettering re-roll in `renderPicture` (`apps/worker/src/content-tasks.ts`).
