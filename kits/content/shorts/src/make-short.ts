// The whole chain, as Nearchant runs it for a post: script → (clip ‖ voice) → subtitles → ffmpeg.
// The clip and the voice are your functions (Nearchant: Wan 2.2 image-to-video on ComfyUI, and its Kokoro + whisper
// service), so any video model or TTS works.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Word } from "./captions.js";
import { pickAccent } from "./colors.js";
import { compose, type FfmpegOptions } from "./ffmpeg.js";
import type { Ask } from "./openai-ask.js";
import { writeScript, type VideoScript } from "./script.js";
import { assSubtitles, MAX_SHORT_S, totalSeconds } from "./subtitles.js";
import type { Tts } from "./tts.js";

/** Picture + motion prompt → a short video clip (a few seconds; any format ffmpeg reads). */
export type ClipMaker = (prompt: string, picture: Uint8Array) => Promise<Uint8Array>;

export interface MakeShortOptions extends FfmpegOptions {
  /** The picture to animate — the clean one, without a headline strip. Portrait (720×1280) works best. */
  picture: Uint8Array;
  /** A ready script; or give `ask` + `about` + `caption` and one is written. */
  script?: VideoScript;
  ask?: Ask;
  about?: string;
  caption?: string;
  angle?: string;
  tts: Tts;
  clip: ClipMaker;
  /** Folder with the caption font (the kit's fonts/). */
  fontsDir: string;
  /** Where to write the MP4. */
  out: string;
  /** "#RRGGBB"; or `brandColors` and the most vivid usable one is picked. */
  accent?: string;
  brandColors?: string[];
  /** End-card (shown when `store` is set). */
  store?: string;
  /** Default "Tap the link to shop". */
  cta?: string;
  link?: string;
  /** Groups files on the TTS side. Default "short". */
  id?: string;
  /** Working folder for the clip, voice and subtitles. Default a temp folder, removed afterwards. */
  workDir?: string;
  /** Extension for the clip file (ffmpeg probes the content anyway). Default "webm" (Comfy's SaveWEBM). */
  clipExt?: string;
  onStep?: (step: "script" | "clip+voice" | "compose", detail?: string) => void;
}

export interface Short { out: string; seconds: number; voiceSeconds: number; script: VideoScript; words: Word[] }

export async function makeShort(o: MakeShortOptions): Promise<Short> {
  let script = o.script;
  if (!script) {
    if (!o.ask || !o.about || !o.caption) throw new Error("pass `script`, or `ask` + `about` + `caption` to write one");
    o.onStep?.("script");
    script = await writeScript(o.ask, { about: o.about, caption: o.caption, ...(o.angle ? { angle: o.angle } : {}) });
  }
  o.onStep?.("clip+voice", script.video_prompt);
  const [clip, voice] = await Promise.all([o.clip(script.video_prompt, o.picture), o.tts(script.voiceover, o.id ?? "short")]);
  if (!clip?.length) throw new Error("the clip maker returned no video");
  if (!voice?.audio?.length || !(voice.seconds > 0)) throw new Error("the TTS returned no audio");

  const own = !o.workDir, dir = o.workDir ?? (await mkdtemp(join(tmpdir(), "short-")));
  try {
    await mkdir(dir, { recursive: true });
    const voiceEnd = Math.min(voice.seconds, MAX_SHORT_S), endcard = !!o.store;
    const ass = assSubtitles({
      hook: script.hook, words: voice.words, script: script.voiceover, voiceEnd, accent: o.accent ?? pickAccent(o.brandColors),
      ...(o.store ? { store: o.store, cta: o.cta ?? "Tap the link to shop" } : {}), ...(o.link ? { link: o.link } : {}),
    });
    const files = { clip: join(dir, `clip.${o.clipExt ?? "webm"}`), voice: join(dir, "voice.wav"), ass: join(dir, "subs.ass") };
    await Promise.all([writeFile(files.clip, clip), writeFile(files.voice, voice.audio), writeFile(files.ass, ass)]);
    const seconds = totalSeconds(voice.seconds, endcard);
    o.onStep?.("compose");
    await compose({ ...files, fontsDir: o.fontsDir, out: o.out, seconds }, o);
    return { out: o.out, seconds, voiceSeconds: voice.seconds, script, words: voice.words };
  } finally {
    if (own) await rm(dir, { recursive: true, force: true });
  }
}
