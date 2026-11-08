/** Escapes text for SVG content and attribute values. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Splits text into at most `lines` lines of about `chars` characters; the last line gets "…" when text was cut.
 * Widths are estimated from character counts (no font metrics), so leave some margin in `chars`.
 */
export function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if ((cur ? `${cur} ${w}` : w).length <= chars) { cur = cur ? `${cur} ${w}` : w; continue; }
    if (cur) out.push(cur);
    cur = w.length > chars ? `${w.slice(0, chars - 1)}…` : w;
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length === lines && out.join(" ").length < text.trim().replace(/\s+/g, " ").length) out[lines - 1] = `${out[lines - 1]!.replace(/[.,;:!?…]?$/, "").slice(0, chars - 1)}…`;
  return out;
}

/** One line, cut with "…" if longer than `chars`. */
export const oneLine = (text: string, chars: number) => wrap(text, chars, 1)[0] ?? "";
