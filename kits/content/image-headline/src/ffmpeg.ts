// Burns the strip onto the picture with ffmpeg's `subtitles` filter (libass). Your ffmpeg must be built with
// libass (`ffmpeg -filters | grep subtitles`); most Linux packages and the static builds are.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pickAccent } from "./colors.js";
import { headlineAss, type HeadlineStyle } from "./headline.js";
import { imageSize } from "./image-size.js";

const run = promisify(execFile);

export interface FfmpegOptions {
  /** ffmpeg binary. Default "ffmpeg" (from PATH). */
  ffmpeg?: string;
  /** Default 60 s. */
  timeoutMs?: number;
}

/** Escapes a path for a filter argument (ffmpeg's own quoting: \ : ' are special). */
export const filterPath = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** The ffmpeg arguments for one picture (exported so you can run them your own way). */
export function headlineArgs(a: { input: string; output: string; ass: string; fontsDir: string }): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", a.input, "-vf", `subtitles=filename='${filterPath(a.ass)}':fontsdir='${filterPath(a.fontsDir)}'`, "-frames:v", "1", a.output];
}

/** Burns an ASS file onto a picture (file in → file out; the output type follows its extension). */
export async function applyHeadline(a: { input: string; output: string; ass: string; fontsDir: string }, o: FfmpegOptions = {}): Promise<void> {
  try {
    await run(o.ffmpeg ?? "ffmpeg", headlineArgs(a), { timeout: o.timeoutMs ?? 60_000 });
  } catch (e) {
    const err = e as Error & { stderr?: string; code?: string | number };
    throw new Error(`ffmpeg failed${err.code === "ENOENT" ? " (not found — install it or pass `ffmpeg`)" : ""}: ${(err.stderr || err.message).trim().slice(0, 400)}`, { cause: e });
  }
}

/** True when this ffmpeg can burn ASS subtitles (has the libass `subtitles` filter). */
export async function canBurnSubtitles(ffmpeg = "ffmpeg"): Promise<boolean> {
  try {
    const { stdout } = await run(ffmpeg, ["-hide_banner", "-filters"], { timeout: 15_000, maxBuffer: 4 << 20 });
    return /^\s*\S+\s+subtitles\s/m.test(stdout);
  } catch { return false; }
}

export interface AddHeadlineOptions extends FfmpegOptions, HeadlineStyle {
  /** Folder with the font file(s), e.g. the kit's fonts/ folder. */
  fontsDir: string;
  /** "#RRGGBB"; or give `brandColors` and the most vivid usable one is picked. */
  accent?: string;
  brandColors?: string[];
}

/** PNG/JPEG bytes in → PNG bytes out with the headline strip. Works in a temp folder it removes afterwards. */
export async function addHeadline(picture: Uint8Array, text: string, o: AddHeadlineOptions): Promise<Uint8Array> {
  const { width, height } = imageSize(picture);
  const dir = await mkdtemp(join(tmpdir(), "headline-"));
  try {
    const input = join(dir, "in.img"), output = join(dir, "out.png"), ass = join(dir, "strip.ass");
    const style: HeadlineStyle = { ...(o.font ? { font: o.font } : {}), ...(o.sizeOfWidth ? { sizeOfWidth: o.sizeOfWidth } : {}), ...(o.upper !== undefined ? { upper: o.upper } : {}) };
    await writeFile(input, picture);
    await writeFile(ass, headlineAss(text, width, height, o.accent ?? pickAccent(o.brandColors), style));
    await applyHeadline({ input, output, ass, fontsDir: o.fontsDir }, o);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
