// Makes a short from a picture.
//   npx tsx example.ts picture.png
// Settings (env):
//   AI_BASE_URL, AI_MODEL, AI_API_KEY   text model for the script (any OpenAI-compatible endpoint)
//   TTS_URL, TTS_API_KEY                the voice service (contract in src/tts.ts)
//   CLIP_FILE                           a ready clip to use instead of a video model (e.g. one made on ComfyUI)
//   FFMPEG                              ffmpeg with libx264 + libass (default "ffmpeg")
// Without them it prints the subtitle file it would burn for a sample voice.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assSubtitles, canBurnSubtitles, httpTts, makeShort, openaiAsk } from "./src/index.js";

const [picturePath] = process.argv.slice(2);
const env = process.env, ffmpeg = env.FFMPEG ?? "ffmpeg";
const ready = picturePath && env.AI_BASE_URL && env.AI_MODEL && env.TTS_URL && env.CLIP_FILE && (await canBurnSubtitles(ffmpeg));
if (!ready) {
  console.log("To run live: npx tsx example.ts picture.png with AI_BASE_URL, AI_MODEL, TTS_URL and CLIP_FILE set,\n" +
    "and ffmpeg with libass on PATH (or FFMPEG). For the clip, Nearchant runs Wan 2.2 image-to-video on ComfyUI\n" +
    "(see the README); here CLIP_FILE stands in for it.\n" +
    `ffmpeg with subtitles: ${(await canBurnSubtitles(ffmpeg)) ? "yes" : "no"}\n\nThe subtitle file for a sample 3-second voice:\n`);
  console.log(assSubtitles({ hook: "Linen for hot days", voiceEnd: 3, accent: "#A83232", store: "Nova Wear", cta: "Tap the link to shop", link: "nova.example",
    words: [{ word: "Cool", start: 0, end: 0.4 }, { word: "and", start: 0.4, end: 0.6 }, { word: "soft.", start: 0.6, end: 1.1 }, { word: "Tap", start: 1.6, end: 1.8 }, { word: "the", start: 1.8, end: 1.9 }, { word: "link.", start: 1.9, end: 2.4 }] }));
  process.exit(0);
}
const r = await makeShort({
  picture: new Uint8Array(await readFile(picturePath)),
  ask: openaiAsk({ baseUrl: env.AI_BASE_URL!, model: env.AI_MODEL!, ...(env.AI_API_KEY ? { apiKey: env.AI_API_KEY } : {}) }),
  about: env.ABOUT ?? "Nova Wear: a small linen clothing studio. Calm, warm voice.",
  caption: env.CAPTION ?? "Our washed linen shirts are back — cool on the hottest days.",
  tts: httpTts({ baseUrl: env.TTS_URL!, ...(env.TTS_API_KEY ? { apiKey: env.TTS_API_KEY } : {}) }),
  clip: async () => new Uint8Array(await readFile(env.CLIP_FILE!)),
  fontsDir: fileURLToPath(new URL("./fonts/", import.meta.url)),
  out: "short.mp4", store: env.STORE ?? "Nova Wear", brandColors: ["#A83232"], ffmpeg,
  onStep: (s, d) => console.log(`  ${s}${d ? `: ${d}` : ""}`),
});
console.log(`wrote ${r.out}: ${r.seconds.toFixed(1)} s — "${r.script.voiceover}"`);
