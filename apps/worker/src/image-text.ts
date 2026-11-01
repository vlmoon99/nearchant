// Text ON post pictures is ours, never the image model's (advertisment_system docs/TEXT_ON_MEDIA_PLAN.md P2–P3):
// a bottom headline strip in the brand colour and font, burned with the same ASS/libass path as the video captions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assColor, balance, onColor } from "./video-compose.js";

/** Appended to every picture prompt: models garble lettering, so the picture itself carries none. */
export const NO_TEXT = " No text, letters, words, numbers, logos or watermarks anywhere in the picture.";

/** The headline strip as an ASS file sized to the picture (bottom strip, brand colour, balanced lines). */
export function headlineAss(text: string, w: number, h: number, accent: string): string {
  const clean = text.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
  const lines = balance(clean).split("\\N").length;
  const size = Math.round(w * 0.062), strip = Math.round(size * (1.25 * lines + 1.1));
  const fg = onColor(accent), A = assColor, c1 = A(accent).replace(/^&H00/, "&H") + "&";
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: Strip,Montserrat ExtraBold,${size},${A(fg)},${A(fg)},${A(accent)},${A(accent)},-1,0,0,0,100,100,1,0,1,0,0,2,40,40,${Math.round((strip - size * 1.25 * lines) / 2)},1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    `Dialogue: 0,0:00:00.00,0:00:05.00,Strip,,0,0,0,,{\\an7\\pos(0,${h - strip})\\p1\\bord0\\shad0\\1c${c1}\\1a&H10&}m 0 0 l ${w} 0 l ${w} ${strip} l 0 ${strip}{\\p0}\n` +
    `Dialogue: 1,0:00:00.00,0:00:05.00,Strip,,0,0,0,,${balance(clean)}\n`;
}

/** Burns the strip onto a picture (PNG in → PNG out). */
export async function applyHeadline(a: { input: string; output: string; ass: string; fontsDir: string }, ffmpeg = process.env.FFMPEG ?? "ffmpeg"): Promise<void> {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  await promisify(execFile)(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", a.input, "-vf", `subtitles=filename='${esc(a.ass)}':fontsdir='${esc(a.fontsDir)}'`, "-frames:v", "1", a.output], { timeout: 60_000 });
}
