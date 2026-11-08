// A real render with ffmpeg + libass. It runs only when `ffmpeg` on PATH has the `subtitles` filter; otherwise it is
// skipped (and says so) — the ASS output itself is covered in headline.test.ts.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addHeadline, canBurnSubtitles, imageSize } from "../src/index.js";

const ok = await canBurnSubtitles("ffmpeg");
if (!ok) console.warn("render.test: skipped — no ffmpeg with the libass `subtitles` filter on PATH");
const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));
const run = promisify(execFile);

describe.skipIf(!ok)("real ffmpeg render", () => {
  it("burns a strip in the accent colour at the bottom and keeps the size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hl-test-"));
    try {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=640x800", "-frames:v", "1", join(dir, "in.png")]);
      const out = await addHeadline(new Uint8Array(await readFile(join(dir, "in.png"))), "Fresh linen for hot days", { fontsDir, accent: "#E63946" });
      expect(imageSize(out)).toEqual({ width: 640, height: 800 });
      await writeFile(join(dir, "out.png"), out);
      // A pixel near the bottom-left corner is the band (accent at ~94 % opacity over grey); one near the top is untouched.
      const px = async (y: number) => [...(await run("ffmpeg", ["-loglevel", "error", "-i", join(dir, "out.png"), "-vf", `crop=1:1:4:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" })).stdout];
      const [r, g, b] = await px(795);
      expect(r).toBeGreaterThan(190); expect(g).toBeLessThan(90); expect(b).toBeLessThan(100);
      for (const c of await px(10)) expect(Math.abs(c - 128)).toBeLessThanOrEqual(4); // colour-space rounding
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
