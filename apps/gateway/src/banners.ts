// Banners (ADR 0027): ready images of a product or service for social posts and other websites, made from the
// item's photo with its name, price, the store and a QR code that opens the item to buy. Rendered with sharp (SVG
// text over the photo); same input → same file, cached on disk next to the store's public files.
import sharp from "sharp";
import QRCode from "qrcode";

export const BANNERS = {
  square: { w: 1080, h: 1080, label: "Instagram & Facebook post", size: "1080 × 1080" },
  story: { w: 1080, h: 1920, label: "Stories, Reels, TikTok", size: "1080 × 1920" },
  wide: { w: 1200, h: 630, label: "Link post: X, Facebook, LinkedIn, Telegram", size: "1200 × 630" },
  rect: { w: 600, h: 500, label: "Ad on a website", size: "300 × 250 (sharp on retina)" },
  leader: { w: 1456, h: 180, label: "Banner on a website", size: "728 × 90 (sharp on retina)" },
} as const;
export type BannerFormat = keyof typeof BANNERS;
export const isBannerFormat = (f: string): f is BannerFormat => f in BANNERS;

export interface BannerInput { photo: Buffer | null; title: string; price: string; store: string; facts: string; url: string; kind: string }

const FONT = "Inter, 'SF Pro Display', 'Helvetica Neue', 'DejaVu Sans', sans-serif";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Splits text into at most `lines` lines of about `chars` characters (the last one gets "…"). */
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
  if (out.length === lines && out.join(" ").length < text.trim().length) out[lines - 1] = `${out[lines - 1]!.replace(/[.,;:!?…]?$/, "").slice(0, chars - 1)}…`;
  return out;
}
const text = (x: number, y: number, size: number, weight: number, fill: string, s: string, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
const lines = (x: number, y: number, size: number, weight: number, fill: string, ls: string[], lh = 1.15) =>
  ls.map((l, i) => text(x, y + i * size * lh, size, weight, fill, l)).join("");
/** A rounded "Buy" pill. */
const pill = (x: number, y: number, h: number, label: string, anchorRight = false) => {
  const w = Math.round(label.length * h * 0.3 + h * 0.9);
  const x0 = anchorRight ? x - w : x;
  return `<rect x="${x0}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#0a84ff"/>${text(x0 + w / 2, y + h * 0.64, Math.round(h * 0.42), 650, "#fff", label, 'text-anchor="middle"')}`;
};

async function photoLayer(photo: Buffer | null, w: number, h: number): Promise<Buffer> {
  if (photo) return sharp(photo).rotate().resize(w, h, { fit: "cover", position: "attention" }).toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: "#1c1c1e" } }).png().toBuffer();
}
async function qr(url: string, size: number): Promise<Buffer> {
  const code = await QRCode.toBuffer(url, { margin: 1, width: size, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const r = Math.round(size * 0.08);
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`);
  return sharp(code).resize(size, size).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

/** One banner as PNG. */
export async function renderBanner(f: BannerFormat, a: BannerInput): Promise<Buffer> {
  const { w, h } = BANNERS[f];
  const cta = a.kind === "service" ? "Book now" : "Buy now";
  const layers: sharp.OverlayOptions[] = [];
  let svg = "";
  if (f === "square" || f === "story") {
    const u = w / 1080, pad = Math.round(64 * u), q = Math.round((f === "story" ? 230 : 200) * u);
    layers.push({ input: await photoLayer(a.photo, w, h), top: 0, left: 0 });
    const titleSize = Math.round((f === "story" ? 84 : 72) * u), title = wrap(a.title, Math.floor((w - pad * 2 - q - 24) / (titleSize * 0.52)), 3);
    const base = h - pad - q;
    svg = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".88"/></linearGradient></defs>
      <rect y="${Math.round(h * 0.38)}" width="${w}" height="${Math.round(h * 0.62)}" fill="url(#g)"/>
      <rect x="${pad - 22 * u}" y="${pad - 14 * u}" width="${Math.round(a.store.length * 34 * u * 0.6 + 44 * u)}" height="${Math.round(66 * u)}" rx="${Math.round(33 * u)}" fill="#000" fill-opacity=".55"/>
      ${text(pad, pad + 30 * u, Math.round(30 * u), 650, "#fff", a.store.toUpperCase(), 'letter-spacing="2"')}
      ${lines(pad, base - (title.length - 1) * titleSize * 1.1 - 92 * u, titleSize, 750, "#fff", title, 1.1)}
      ${text(pad, base + 6 * u, Math.round(54 * u), 700, "#fff", a.price)}
      ${text(pad, base + 60 * u, Math.round(32 * u), 450, "#fff", a.facts, 'opacity=".8"')}
      ${pill(pad, h - pad - Math.round(86 * u), Math.round(86 * u), cta)}
      ${text(w - pad - q / 2, h - pad - q - 18 * u, Math.round(26 * u), 600, "#fff", "Scan to buy", 'text-anchor="middle" opacity=".9"')}
      ${text(pad + Math.round(cta.length * 86 * u * 0.3 + 86 * u * 0.9) + 24 * u, h - pad - 30 * u, Math.round(28 * u), 500, "#fff", "Safe payment · escrow on NEAR", 'opacity=".8"')}`;
    layers.push({ input: await qr(a.url, q), top: h - pad - q, left: w - pad - q });
  } else if (f === "wide") {
    const half = 600, pad = 56, q = 170;
    layers.push({ input: await photoLayer(a.photo, half, h), top: 0, left: 0 });
    const title = wrap(a.title, 19, 3);
    svg = `<rect x="${half}" width="${w - half}" height="${h}" fill="#111113"/>
      ${text(half + pad, pad + 26, 26, 650, "#8e8e93", a.store.toUpperCase(), 'letter-spacing="2"')}
      ${lines(half + pad, pad + 100, 52, 750, "#fff", title, 1.12)}
      ${text(half + pad, h - pad - 150, 44, 700, "#fff", a.price)}
      ${text(half + pad, h - pad - 108, 24, 450, "#a1a1a6", a.facts)}
      ${pill(half + pad, h - pad - 70, 70, cta)}
      ${text(w - pad - q / 2, h - pad - q - 14, 20, 600, "#a1a1a6", "Scan to buy", 'text-anchor="middle"')}`;
    layers.push({ input: await qr(a.url, q), top: h - pad - q, left: w - pad - q });
  } else if (f === "rect") {
    const ph = 290, pad = 28;
    layers.push({ input: await photoLayer(a.photo, w, ph), top: 0, left: 0 });
    svg = `<rect y="${ph}" width="${w}" height="${h - ph}" fill="#111113"/>
      ${text(pad, ph + 52, 36, 750, "#fff", wrap(a.title, 26, 1)[0] ?? "")}
      ${text(pad, ph + 96, 30, 700, "#fff", a.price)}
      ${text(pad, ph + 140, 22, 500, "#a1a1a6", wrap(a.store, 20, 1)[0] ?? "")}
      ${text(pad, ph + 172, 20, 500, "#a1a1a6", "Safe payment · escrow on NEAR")}
      ${pill(w - pad, ph + 104, 60, cta, true)}`;
  } else {
    const pad = 28;
    layers.push({ input: await photoLayer(a.photo, h, h), top: 0, left: 0 });
    svg = `<rect x="${h}" width="${w - h}" height="${h}" fill="#111113"/>
      ${text(h + pad, 66, 46, 750, "#fff", wrap(a.title, 34, 1)[0] ?? "")}
      ${text(h + pad, 124, 30, 500, "#a1a1a6", `${a.price} · ${a.store} · safe payment on NEAR`)}
      ${pill(w - pad, (h - 84) / 2, 84, cta, true)}`;
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`), top: 0, left: 0 });
  // The QR goes over the gradient/text layer: order photo → text → QR.
  const qrLayer = layers.length === 3 ? layers.splice(1, 1)[0]! : null;
  if (qrLayer) layers.push(qrLayer);
  return sharp({ create: { width: w, height: h, channels: 3, background: "#000" } }).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}
