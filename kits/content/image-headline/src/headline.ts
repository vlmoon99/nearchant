// The headline strip as an ASS subtitle file: a bottom band in the brand colour with the headline in a readable
// colour on it, balanced over two lines. Text on post pictures is ours, never the image model's (models garble it).
import { assColor, onColor } from "./colors.js";

/** ASS text must not open override blocks or break lines: braces and backslashes go, whitespace collapses. */
export const assText = (s: string) => s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

/** Balanced 2-line wrap (one long + one short line reads badly). Lines are joined with ASS's "\N". */
export function balance(text: string): string {
  const words = text.split(" ");
  if (text.length <= 14 || words.length < 2) return text;
  let best = 1, diff = Infinity;
  for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length); if (d < diff) { diff = d; best = i; } }
  return `${words.slice(0, best).join(" ")}\\N${words.slice(best).join(" ")}`;
}

export interface HeadlineStyle {
  /** Font family name as the font file declares it. Default "Montserrat ExtraBold" (shipped in fonts/). */
  font?: string;
  /** Font size as a share of the picture width. Default 0.078. */
  sizeOfWidth?: number;
  /** Upper-case the headline. Default true. */
  upper?: boolean;
}

/** The strip as an ASS file sized to the picture (w × h pixels). `accent` is "#RRGGBB". */
export function headlineAss(text: string, w: number, h: number, accent: string, style: HeadlineStyle = {}): string {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error(`accent must be "#RRGGBB", got ${JSON.stringify(accent)}`);
  if (!(w > 0 && h > 0)) throw new Error("width and height must be positive");
  let clean = assText(text);
  if (style.upper ?? true) clean = clean.toUpperCase();
  const wrapped = balance(clean), lines = wrapped.split("\\N").length;
  const size = Math.round(w * (style.sizeOfWidth ?? 0.078)), strip = Math.round(size * (1.25 * lines + 1.1));
  const fg = onColor(accent), A = assColor, c1 = A(accent).replace(/^&H00/, "&H") + "&";
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: Strip,${style.font ?? "Montserrat ExtraBold"},${size},${A(fg)},${A(fg)},${A(accent)},${A(accent)},-1,0,0,0,100,100,1,0,1,0,0,2,40,40,${Math.round((strip - size * 1.25 * lines) / 2)},1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    // Layer 0: the band, an ASS vector rectangle across the bottom. Layer 1: the text on it.
    `Dialogue: 0,0:00:00.00,0:00:05.00,Strip,,0,0,0,,{\\an7\\pos(0,${h - strip})\\p1\\bord0\\shad0\\1c${c1}\\1a&H10&}m 0 0 l ${w} 0 l ${w} ${strip} l 0 ${strip}{\\p0}\n` +
    `Dialogue: 1,0:00:00.00,0:00:05.00,Strip,,0,0,0,,${wrapped}\n`;
}
