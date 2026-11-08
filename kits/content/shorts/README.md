# Shorts

8–12 second vertical shorts from one picture: the picture comes alive in a short clip, one voice says one idea,
word-timed captions repeat it, a hook opens it and an end-card in the brand colour closes it — put together with ffmpeg.

## Copy it

```sh
cp -r kits/content/shorts your-project/src/shorts
npm i -D typescript vitest @types/node tsx   # only to run its tests/example; no runtime dependencies
```

```ts
import { makeShort, httpTts, openaiAsk } from "./shorts/src/index.js";
```

Needs **ffmpeg with libx264 and libass** (`ffmpeg -filters | grep subtitles`; Debian/Ubuntu `apt install ffmpeg` has
both, Homebrew's default formula has no libass). Montserrat ExtraBold (SIL OFL, `fonts/OFL.txt`) is included.

## Use it

```ts
import { fileURLToPath } from "node:url";

const short = await makeShort({
  picture: cleanPngBytes,                                  // no headline strip on it
  ask: openaiAsk({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" }),
  about: "Nova Wear: a small linen clothing studio in Lisbon. Calm, warm voice.",
  caption: "Our washed linen shirts are back — cool on the hottest days.",
  tts: httpTts({ baseUrl: process.env.TTS_URL! }),         // or your own TTS function
  clip: async (prompt, picture) => myVideoModel(prompt, picture), // image-to-video, a few seconds
  fontsDir: fileURLToPath(new URL("./shorts/fonts/", import.meta.url)),
  out: "short.mp4",
  brandColors: ["#A83232"], store: "Nova Wear", link: "novawear.example",
});
// short.seconds (voice + 0.4 s + 1.5 s end-card), short.script { hook, voiceover, video_prompt }, short.words
```

Have a script already? Pass `script` instead of `ask`/`about`/`caption`.

### The clip function

`(prompt: string, picture: Uint8Array) => Promise<Uint8Array>` — any video ffmpeg reads. **Nearchant uses ComfyUI**
for it: Wan 2.2 image-to-video (A14B + Lightning 4-step, 5 s, 704×1280) on Comfy Cloud. With the
`product-images` kit:

```ts
import { ComfyClient, fillWorkflow, WORKFLOWS } from "./product-images/src/index.js";
const comfy = new ComfyClient({ apiKey: process.env.COMFY_API_KEY });
const clip = async (prompt: string, picture: Uint8Array) => {
  const ref = await comfy.upload(picture, `video-${Date.now()}.png`);
  const wf = fillWorkflow(WORKFLOWS.wan22_i2v14b_l4, { prompt, ref, seed: Math.floor(Math.random() * 2 ** 31), width: 704, height: 1280 });
  return (await comfy.run(wf)).bytes;   // WEBM
};
```

### The TTS function

`(text: string, id: string) => Promise<{ audio: Uint8Array; words: { word, start, end }[]; seconds: number }>` —
audio ffmpeg reads, word timings in seconds (empty → no captions), and the audio length. `httpTts` talks to the
service Nearchant runs (Kokoro-82M voice + faster-whisper word timestamps):

| Call | Body | Answer |
|---|---|---|
| `POST /generate` | `{ text, lang: "en", product_id, voice?, speed? }` | `{ audio: { path, duration_s } }` |
| `GET /files/<path>` | — | the WAV |
| `POST /transcribe` | `{ path, lang, word_timestamps: true }` | `{ words: [{ word, start, end }] }` |

`Authorization: Bearer <apiKey>` when set. Anything else (ElevenLabs with timestamps, OpenAI TTS + Whisper) works
if you return the same shape.

## Options

`makeShort(options)`

| Option | Default | What |
|---|---|---|
| `picture` | — | The picture to animate. Portrait 720×1280 works best (Nearchant resizes to it first). |
| `script` | — | `{ hook, voiceover, video_prompt }`; or `ask` + `about` + `caption` (+ `angle`) to write one. |
| `tts` / `clip` | — | Your voice and video functions (above). |
| `fontsDir` | — | Folder with the caption font. |
| `out` | — | MP4 path. |
| `accent` / `brandColors` | `#007AFF` | Brand colour, or a list to pick the most vivid usable one from. |
| `store`, `cta`, `link` | —, "Tap the link to shop", — | End-card (only when `store` is set). |
| `id` | `"short"` | Groups files on the TTS side. |
| `workDir` | temp, removed | Keep the clip, voice and `subs.ass` here instead. |
| `clipExt` | `"webm"` | File extension for the clip (ffmpeg probes content anyway). |
| `ffmpeg` / `timeoutMs` | `"ffmpeg"` / 180 000 | Per ffmpeg step. |
| `run` | execFile | Replace how ffmpeg runs (tests, a remote box). |
| `onStep` | — | `"script"`, `"clip+voice"`, `"compose"`. |

`httpTts({ baseUrl, apiKey?, lang = "en", voice?, speed?, retries = 2, backoffMs = 1000, timeoutMs = 120000, fetch? })`.
Pure parts are exported too: `writeScript`, `readScript`, `alignToScript`, `captionChunks`, `assSubtitles`,
`composeArgs`, `pingpongArgs`, `totalSeconds`, `pickAccent`.

## How it works

```
ask ──► script {hook, voiceover (12–20 words, no numbers), video_prompt (camera moves only)}
          │
          ├──► clip(video_prompt, picture) ─┐   in parallel
          └──► tts(voiceover) ──────────────┤
                                            ▼
   subs.ass: hook 0–2.5 s (brand box) · captions ≤3 words/18 chars on a dark pill at ~70 % height,
             script words on whisper's timing · end-card 1.5 s after voice + 0.4 s
                                            ▼
   ffmpeg 1: clip forward + reversed (seamless loop)
   ffmpeg 2: loop → 720×1280, 24 fps, light grade + grain, burn subs; voice loudnorm −16 LUFS + silence pad;
             cut at voice (≤12 s) + 0.4 + 1.5 s → H.264/AAC MP4, faststart
```

- The script is model output, so it is validated: a voiceover sentence with a digit is dropped (TTS reads numbers
  badly, and they are the claims most often made up), the hook is capped at 5 words, the voice at ~22 words, and a
  motion that brings in people or hands is replaced by a camera-only push-in.
- Captions show what the script says on the transcription's timing, so a misheard word ("so ho" for "SoHo") is right.
- All on-screen text is ours; the video model is told to draw none.

## Tested

`npm test` — 34 tests, no network, ffmpeg replaced by a recorder where needed: alignment, caption chunking, colours,
wrapping, the subtitle file (hook, caption pill, end-card timing and colour, no end-card without a store), compose
and pingpong arguments, the 12 s cap, script validation (numbers, hook length, people/hands, junk answers, data blocks),
`httpTts` (flow, retry on 502, no retry on 4xx, bad answers, path traversal, timeout), the `makeShort` chain and its
failure paths (no script source, empty clip, no audio, clip-maker error, missing ffmpeg), and the OpenAI adapter.
One **real render test** (720×1280 MP4 with audio, expected length) runs only when ffmpeg on PATH has libass,
otherwise it is skipped with a note; it was run in Docker (`node:24-bookworm` + Debian ffmpeg).

Not tested here: a live TTS service, a live video model, and the look of the result — `example.ts` runs live.

## Came from

Nearchant's post videos: `apps/worker/src/video-compose.ts` (captions, subtitles, ffmpeg), `apps/worker/src/tts.ts`
(the voice client; service in `deploy/video-engine/tts`), the video director prompt and `writeVideoScript`
(`envs/content-store/prompts/video-director.md`, `packages/swarm/src/content.ts`) and the chain in `makeVideoTask`
(`apps/worker/src/content-tasks.ts`), with the clip from Wan 2.2 on Comfy Cloud (`apps/worker/src/main.ts`).
