// A post's short video, put together with ffmpeg. Ported from advertisment_system (short._compose, subtitles.py,
// overlay.py, docs/TEXT_ON_MEDIA_PLAN.md): text is always ours, never drawn by the video model —
//   hook (first 2.5 s, brand-colour box, safe area) · word-timed captions with the SCRIPT's words on a dark pill at
//   ~70 % height · a 1.5 s end-card in the brand colour with the store name and the call to action.
// The 5 s clip plays forward then backward under the voice; captions are ASS subtitles burned by libass.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface Word { word: string; start: number; end: number }
export const VIDEO_W = 720, VIDEO_H = 1280;
/** Voice length cap: a short is caught in one glance (~8–10 s of voice, never more than 12). */
export const MAX_SHORT_S = 12;
export const ENDCARD_S = 1.5;
const TAIL_S = 0.4, MAX_GAP_S = 0.6, MIN_SHOW_S = 0.3;

/** Whisper's TIMING, the script's TEXT (advertisment_system subtitles.align_to_script): re-transcribing our own
 *  voiceover sometimes mishears, but we know what was said. Script words are laid on whisper's timeline by their
 *  share of the characters, so pace and pauses carry over even when word counts differ. */
export function alignToScript(words: Word[], script: string): Word[] {
  const spoken = (script ?? "").split(/\s+/).filter(Boolean);
  const timed = words.filter((w) => w.word.trim() && w.end >= w.start && w.start >= 0).map((w) => ({ n: Math.max(w.word.trim().length, 1), s: w.start, e: w.end }));
  if (!spoken.length || !timed.length) return words;
  if (spoken.length === timed.length) return spoken.map((word, i) => ({ word, start: timed[i]!.s, end: timed[i]!.e }));
  const totalW = timed.reduce((a, x) => a + x.n, 0), totalS = spoken.reduce((a, w) => a + w.length, 0);
  const at = (pos: number) => {
    let acc = 0;
    for (const x of timed) { if (pos <= acc + x.n) return x.s + ((x.e - x.s) * Math.max(pos - acc, 0)) / x.n; acc += x.n; }
    return timed.at(-1)!.e;
  };
  let acc = 0;
  return spoken.map((word) => { const a = acc; acc += word.length; return { word, start: at((a / totalS) * totalW), end: at((acc / totalS) * totalW) }; });
}

/** Caption chunks: ≤3 words / 18 characters; a pause (> 0.6 s) or a sentence end starts a new one; each shows at
 *  least 0.3 s, is held until the next one starts (≤ +0.6 s) and never overlaps it. */
export function captionChunks(words: Word[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ text: cur.map((w) => w.word).join(" "), start: cur[0]!.start, end: Math.max(cur.at(-1)!.end, cur[0]!.start + MIN_SHOW_S) }); cur = []; };
  for (const w of words.filter((x) => x.word.trim())) {
    const text = [...cur, w].map((x) => x.word).join(" ");
    if (cur.length && (cur.length >= 3 || text.length > 18 || w.start - cur.at(-1)!.end > MAX_GAP_S)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.word)) flush();
  }
  flush();
  return out.map((c, i) => ({ ...c, end: Math.min(out[i + 1]?.start ?? c.end + 0.3, c.end + 0.6) }));
}

/** The accent for overlays: the most vivid brand colour that is neither near-white nor near-black. */
export function pickAccent(colors: string[] | undefined, fallback = "#007AFF"): string {
  let best: { c: string; s: number } | null = null;
  for (const c of colors ?? []) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c); if (!m) continue;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255) as [number, number, number];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (l < 0.18 || l > 0.85) continue;
    const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    if (!best || s > best.s) best = { c: `#${m[1]!.toUpperCase()}`, s };
  }
  return best && best.s > 0.25 ? best.c : fallback;
}

/** "#RRGGBB" (+ alpha 0–255, 0 = opaque) → ASS "&HAABBGGRR". */
export const assColor = (hex: string, alpha = 0) => { const h = hex.replace("#", ""); return `&H${alpha.toString(16).padStart(2, "0")}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
const luma = (hex: string) => { const h = hex.replace("#", ""); return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16); };
/** Text colour that reads on a background: near-black on light colours, white on dark ones. */
export const onColor = (hex: string) => (luma(hex) > 150 ? "#111111" : "#FFFFFF");
const t = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
/** ASS text must not open override blocks or break lines: braces and backslashes go. */
const assText = (s: string) => s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
/** Balanced 2-line wrap (one long + one short line reads badly). */
export function balance(text: string): string {
  const words = text.split(" ");
  if (text.length <= 14 || words.length < 2) return text;
  let best = 1, diff = Infinity;
  for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length); if (d < diff) { diff = d; best = i; } }
  return `${words.slice(0, best).join(" ")}\\N${words.slice(best).join(" ")}`;
}

export interface Overlay { hook: string; words: Word[]; script?: string; accent?: string; store?: string; cta?: string; link?: string; voiceEnd: number }

/** The subtitle file: hook, captions, end-card. */
export function assSubtitles(o: Overlay): string {
  const accent = o.accent ?? "#007AFF", fg = onColor(accent), A = assColor;
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${VIDEO_W}\nPlayResY: ${VIDEO_H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n` +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    // BorderStyle 3 = a box behind the text (the contrast scrim): brand colour for the hook, translucent dark for captions.
    `Style: Hook,Montserrat ExtraBold,60,${A(fg)},${A(fg)},${A(accent)},${A("#000000", 0xa0)},-1,0,0,0,100,100,0,0,3,16,0,8,70,70,150,1\n` +
    `Style: Cap,Montserrat ExtraBold,58,${A("#FFFFFF")},${A("#FFFFFF")},${A("#000000", 0x70)},${A("#000000", 0xa0)},-1,0,0,0,100,100,0,0,3,14,0,2,80,80,${Math.round(VIDEO_H * 0.3)},1\n` +
    `Style: Card,Montserrat ExtraBold,64,${A(fg)},${A(fg)},${A(accent)},${A(accent)},-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const lines: string[] = [];
  const hook = assText(o.hook).toUpperCase();
  if (hook) lines.push(`Dialogue: 1,${t(0)},${t(Math.min(2.5, o.voiceEnd))},Hook,,0,0,0,,{\\fad(120,200)}${balance(hook)}`);
  const words = o.script ? alignToScript(o.words, o.script) : o.words;
  for (const c of captionChunks(words)) if (c.start < o.voiceEnd + TAIL_S) lines.push(`Dialogue: 0,${t(c.start)},${t(Math.min(c.end, o.voiceEnd + TAIL_S))},Cap,,0,0,0,,${assText(c.text)}`);
  // End-card: a full-frame brand-colour rectangle (ASS vector drawing), the store name, the CTA, the store address.
  if (o.store) {
    const a = o.voiceEnd + TAIL_S, b = a + ENDCARD_S, c1 = A(accent).replace(/^&H00/, "&H") + "&";
    lines.push(`Dialogue: 2,${t(a)},${t(b)},Card,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${c1}\\fad(150,0)}m 0 0 l ${VIDEO_W} 0 l ${VIDEO_W} ${VIDEO_H} l 0 ${VIDEO_H}{\\p0}`);
    lines.push(`Dialogue: 3,${t(a)},${t(b)},Card,,0,0,0,,{\\an5\\pos(${VIDEO_W / 2},${Math.round(VIDEO_H * 0.42)})\\fad(150,0)}${balance(assText(o.store))}`);
    if (o.cta) lines.push(`Dialogue: 3,${t(a)},${t(b)},Card,,0,0,0,,{\\an5\\pos(${VIDEO_W / 2},${Math.round(VIDEO_H * 0.56)})\\fs40\\fad(150,0)}${assText(o.cta)}`);
    if (o.link) lines.push(`Dialogue: 3,${t(a)},${t(b)},Card,,0,0,0,,{\\an5\\pos(${VIDEO_W / 2},${Math.round(VIDEO_H * 0.62)})\\fs30\\b0\\fad(150,0)}${assText(o.link)}`);
  }
  return head + lines.join("\n") + "\n";
}

/** Total length: the voice (capped) + a short tail + the end-card when there is one. */
export const totalSeconds = (voice: number, endcard: boolean) => Math.min(voice, MAX_SHORT_S) + TAIL_S + (endcard ? ENDCARD_S : 0);

/** ffmpeg arguments. The looped clip is cut by an explicit length: -shortest does not bound a looped input inside
 *  a filter graph. The voice is padded with silence under the end-card. */
export function composeArgs(a: { clip: string; voice: string; ass: string; fontsDir: string; out: string; seconds: number }): string[] {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
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

export async function compose(a: Parameters<typeof composeArgs>[0], ffmpeg = process.env.FFMPEG ?? "ffmpeg"): Promise<void> {
  const run = (args: string[]) => promisify(execFile)(ffmpeg, args, { timeout: 180_000, maxBuffer: 4 << 20 });
  const loop = a.clip.replace(/\.[^./]+$/, "") + "-pingpong.mp4";
  await run(pingpongArgs(a.clip, loop));
  await run(composeArgs({ ...a, clip: loop }));
}
