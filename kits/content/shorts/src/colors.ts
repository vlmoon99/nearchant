// Brand colours for overlays: pick the accent, choose a readable text colour on it, write it the way ASS wants.

/** The accent for overlays: the most vivid brand colour that is neither near-white nor near-black. */
export function pickAccent(colors: string[] | undefined, fallback = "#007AFF"): string {
  let best: { c: string; s: number } | null = null;
  for (const c of colors ?? []) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim()); if (!m) continue;
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

/** Perceived brightness 0–255. */
export const luma = (hex: string) => { const h = hex.replace("#", ""); return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16); };

/** Text colour that reads on a background: near-black on light colours, white on dark ones. */
export const onColor = (hex: string) => (luma(hex) > 150 ? "#111111" : "#FFFFFF");
