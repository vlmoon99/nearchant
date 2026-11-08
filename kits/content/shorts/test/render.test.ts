// A real end-to-end render with ffmpeg (libx264 + libass). It runs only when `ffmpeg` on PATH has the `subtitles`
// filter; otherwise it is skipped (and says so). Inputs are made by ffmpeg itself: a test-pattern clip and a tone.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canBurnSubtitles, makeShort } from "../src/index.js";

const ok = await canBurnSubtitles("ffmpeg");
if (!ok) console.warn("render.test: skipped — no ffmpeg with the libass `subtitles` filter on PATH");
const run = promisify(execFile);

describe.skipIf(!ok)("real ffmpeg render", () => {
  it("makes a 720×1280 MP4 of voice + tail + end-card length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "short-render-"));
    try {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=704x1280:d=2:r=16", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "c.mp4")]);
      await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=3", join(dir, "v.wav")]);
      const r = await makeShort({
        picture: new Uint8Array([1]), script: { hook: "Linen for hot days", voiceover: "Cool and soft. Tap the link.", video_prompt: "push-in" },
        clip: async () => new Uint8Array(await readFile(join(dir, "c.mp4"))),
        tts: async () => ({ audio: new Uint8Array(await readFile(join(dir, "v.wav"))), seconds: 3, words: [{ word: "Cool", start: 0, end: 0.5 }, { word: "and", start: 0.5, end: 0.7 }, { word: "soft.", start: 0.7, end: 1.2 }] }),
        fontsDir: fileURLToPath(new URL("../fonts/", import.meta.url)), out: join(dir, "out.mp4"), accent: "#A83232", store: "Nova Wear", clipExt: "mp4",
      });
      const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", r.out])).stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
      expect(probe.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 720, height: 1280 });
      expect(probe.streams.some((s) => s.codec_type === "audio")).toBe(true);
      expect(Number(probe.format.duration)).toBeCloseTo(4.9, 0); // 3 + 0.4 + 1.5
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 120_000);
});
