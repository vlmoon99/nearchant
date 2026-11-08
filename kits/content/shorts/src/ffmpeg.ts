// ffmpeg steps: the 5 s clip forward-then-backward (so looping it has no jump), then scale/crop to 720×1280,
// a light grade + grain, the burned subtitles, the voice loudness-normalised and padded under the end-card.
// Needs ffmpeg with libx264 and libass (`ffmpeg -filters | grep subtitles`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VIDEO_H, VIDEO_W } from "./subtitles.js";

const exec = promisify(execFile);
const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** The final mix. The looped clip is cut by an explicit length: -shortest does not bound a looped input inside a
 *  filter graph. */
export function composeArgs(a: { clip: string; voice: string; ass: string; fontsDir: string; out: string; seconds: number }): string[] {
  const v = `[0:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},fps=24,` +
    `eq=contrast=1.04:saturation=0.95:gamma=0.98,noise=alls=4:allf=t,subtitles=filename='${esc(a.ass)}':fontsdir='${esc(a.fontsDir)}',format=yuv420p[v]`;
  const au = "[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,apad[a]";
  return ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", a.clip, "-i", a.voice,
    "-filter_complex", `${v};${au}`, "-map", "[v]", "-map", "[a]", "-t", a.seconds.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", a.out];
}

/** The clip forward then backward, so looping it under a long voice has no visible jump back to the start. */
export function pingpongArgs(clip: string, out: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", clip, "-filter_complex", "[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out];
}

export interface FfmpegOptions {
  /** Default "ffmpeg" from PATH. */
  ffmpeg?: string;
  /** Per ffmpeg step. Default 180 s. */
  timeoutMs?: number;
  /** Replace how ffmpeg is run (tests, a remote worker…). Gets the arguments. */
  run?: (args: string[]) => Promise<void>;
}

export function ffmpegRunner(o: FfmpegOptions = {}): (args: string[]) => Promise<void> {
  if (o.run) return o.run;
  return async (args) => {
    try { await exec(o.ffmpeg ?? "ffmpeg", args, { timeout: o.timeoutMs ?? 180_000, maxBuffer: 4 << 20 }); } catch (e) {
      const err = e as Error & { stderr?: string; code?: string | number };
      throw new Error(`ffmpeg failed${err.code === "ENOENT" ? " (not found — install it or pass `ffmpeg`)" : ""}: ${(err.stderr || err.message).trim().slice(0, 400)}`, { cause: e });
    }
  };
}

/** Pingpong the clip, then mix. `clip` is any video ffmpeg reads (Comfy's WEBM, MP4…). */
export async function compose(a: Parameters<typeof composeArgs>[0], o: FfmpegOptions = {}): Promise<void> {
  const run = ffmpegRunner(o);
  const loop = a.clip.replace(/\.[^./]+$/, "") + "-pingpong.mp4";
  await run(pingpongArgs(a.clip, loop));
  await run(composeArgs({ ...a, clip: loop }));
}

/** True when this ffmpeg can burn ASS subtitles (has the libass `subtitles` filter). */
export async function canBurnSubtitles(ffmpeg = "ffmpeg"): Promise<boolean> {
  try {
    const { stdout } = await exec(ffmpeg, ["-hide_banner", "-filters"], { timeout: 15_000, maxBuffer: 4 << 20 });
    return /^\s*\S+\s+subtitles\s/m.test(stdout);
  } catch { return false; }
}
