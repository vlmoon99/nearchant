// The short's text layer as one ASS subtitle file (burned by libass). Text is always ours, never drawn by the video
// model: a hook in the first 2.5 s on a brand-colour box, word-timed captions on a dark pill at ~70 % height, and a
// 1.5 s end-card in the brand colour with the store name, the call to action and the store address.
import { alignToScript, captionChunks, type Word } from "./captions.js";
import { assColor, onColor } from "./colors.js";

export const VIDEO_W = 720, VIDEO_H = 1280;
/** Voice length cap: a short is caught in one glance (~8–10 s of voice, never more than 12). */
export const MAX_SHORT_S = 12;
export const ENDCARD_S = 1.5;
export const TAIL_S = 0.4;

const t = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
/** ASS text must not open override blocks or break lines: braces and backslashes go. */
export const assText = (s: string) => s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
/** Balanced 2-line wrap (one long + one short line reads badly). */
export function balance(text: string): string {
  const words = text.split(" ");
  if (text.length <= 14 || words.length < 2) return text;
  let best = 1, diff = Infinity;
  for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length); if (d < diff) { diff = d; best = i; } }
  return `${words.slice(0, best).join(" ")}\\N${words.slice(best).join(" ")}`;
}

export interface Overlay {
  /** 2–5 words shown big in the first 2.5 s. */
  hook: string;
  /** Word timings from the TTS service. */
  words: Word[];
  /** What the voice actually says: its words replace misheard ones (timing kept). */
  script?: string;
  /** "#RRGGBB" brand colour. Default "#007AFF". */
  accent?: string;
  /** End-card: shown only when `store` is set. */
  store?: string;
  cta?: string;
  link?: string;
  /** When the voice ends (seconds). */
  voiceEnd: number;
  /** Font family name. Default "Montserrat ExtraBold" (shipped in fonts/). */
  font?: string;
}

/** The subtitle file: hook, captions, end-card. */
export function assSubtitles(o: Overlay): string {
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent ?? "") ? o.accent! : "#007AFF", fg = onColor(accent), A = assColor, font = o.font ?? "Montserrat ExtraBold";
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${VIDEO_W}\nPlayResY: ${VIDEO_H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n` +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    // BorderStyle 3 = a box behind the text (the contrast scrim): brand colour for the hook, translucent dark for captions.
    `Style: Hook,${font},60,${A(fg)},${A(fg)},${A(accent)},${A("#000000", 0xa0)},-1,0,0,0,100,100,0,0,3,16,0,8,70,70,150,1\n` +
    `Style: Cap,${font},62,${A("#FFFFFF")},${A("#FFFFFF")},${A("#000000", 0x38)},${A("#000000", 0xa0)},-1,0,0,0,100,100,0,0,3,14,0,2,80,80,${Math.round(VIDEO_H * 0.3)},1\n` +
    `Style: Card,${font},88,${A(fg)},${A(fg)},${A(accent)},${A(accent)},-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1\n\n` +
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
    if (o.cta) lines.push(`Dialogue: 3,${t(a)},${t(b)},Card,,0,0,0,,{\\an5\\pos(${VIDEO_W / 2},${Math.round(VIDEO_H * 0.56)})\\fs50\\fad(150,0)}${assText(o.cta)}`);
    if (o.link) lines.push(`Dialogue: 3,${t(a)},${t(b)},Card,,0,0,0,,{\\an5\\pos(${VIDEO_W / 2},${Math.round(VIDEO_H * 0.62)})\\fs36\\b0\\fad(150,0)}${assText(o.link)}`);
  }
  return head + lines.join("\n") + "\n";
}

/** Total length: the voice (capped) + a short tail + the end-card when there is one. */
export const totalSeconds = (voice: number, endcard: boolean) => Math.min(voice, MAX_SHORT_S) + TAIL_S + (endcard ? ENDCARD_S : 0);
