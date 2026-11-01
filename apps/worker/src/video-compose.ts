// A post's short video, put together with ffmpeg (port of advertisment_system `short._compose`, captions as ASS
// subtitles burned by libass instead of PNG overlays): the 5 s clip loops under the voiceover, a filmic grade,
// the hook on top for the first seconds, word-timed captions at the bottom, loudness-normalised voice.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface Word { word: string; start: number; end: number }
export const VIDEO_W = 720, VIDEO_H = 1280, MAX_SHORT_S = 20;

/** Caption chunks of at most 3 words / 18 characters, timed by the words (subtitles.py rule). */
export function captionChunks(words: Word[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ text: cur.map((w) => w.word).join(" "), start: cur[0]!.start, end: cur.at(-1)!.end }); cur = []; };
  for (const w of words.filter((x) => x.word.trim())) {
    const text = [...cur, w].map((x) => x.word).join(" ");
    if (cur.length && (cur.length >= 3 || text.length > 18)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) flush();
  }
  flush();
  // Each chunk stays until the next one starts, so the captions never flicker off mid-sentence.
  return out.map((c, i) => ({ ...c, end: Math.max(c.end, Math.min(out[i + 1]?.start ?? c.end, c.end + 0.6)) }));
}

const t = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
/** ASS text must not open override blocks or break lines: braces and backslashes go. */
const assText = (s: string) => s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

/** The subtitle file: the hook (top, first 2.5 s) and the captions (lower third). */
export function assSubtitles(hook: string, words: Word[]): string {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${VIDEO_W}\nPlayResY: ${VIDEO_H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n` +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Hook,Montserrat ExtraBold,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,2,8,60,60,150,1\n" +
    "Style: Cap,Montserrat ExtraBold,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,260,1\n\n" +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const lines = [];
  if (assText(hook)) lines.push(`Dialogue: 1,${t(0)},${t(2.5)},Hook,,0,0,0,,{\\fad(150,250)}${assText(hook).toUpperCase()}`);
  for (const c of captionChunks(words)) lines.push(`Dialogue: 0,${t(c.start)},${t(c.end)},Cap,,0,0,0,,${assText(c.text)}`);
  return head + lines.join("\n") + "\n";
}

/** ffmpeg arguments. The looped clip is cut by an explicit length (voice + a short tail, capped): -shortest does not
 *  bound a looped input inside a filter graph. */
export function composeArgs(a: { clip: string; voice: string; ass: string; fontsDir: string; out: string; seconds: number; maxS?: number }): string[] {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  const v = `[0:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},fps=24,` +
    `eq=contrast=1.04:saturation=0.95:gamma=0.98,noise=alls=4:allf=t,subtitles=filename='${esc(a.ass)}':fontsdir='${esc(a.fontsDir)}',format=yuv420p[v]`;
  const au = "[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=0.6[a]";
  return ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", a.clip, "-i", a.voice,
    "-filter_complex", `${v};${au}`, "-map", "[v]", "-map", "[a]", "-t", (Math.min(a.seconds + 0.6, a.maxS ?? MAX_SHORT_S)).toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", a.out];
}

/** The clip forward then backward, so looping it under a long voice has no visible jump back to the start. */
export function pingpongArgs(clip: string, out: string): string[] {
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", clip, "-filter_complex", "[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out];
}

export async function compose(a: Parameters<typeof composeArgs>[0], ffmpeg = process.env.FFMPEG ?? "ffmpeg"): Promise<void> {
  const run = (args: string[]) => promisify(execFile)(ffmpeg, args, { timeout: 180_000, maxBuffer: 4 << 20 });
  const loop = a.clip.replace(/\.[^./]+$/, "") + "-pingpong.mp4";
  await run(pingpongArgs(a.clip, loop));
  await run(composeArgs({ ...a, clip: loop }));
}
