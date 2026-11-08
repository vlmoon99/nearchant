// Ready images of a product or service for social posts and other websites: the item's photo with its name, price,
// the store and a QR code that opens the item to buy. sharp composites the photo, an SVG text layer and the QR.
import sharp from "sharp";
import QRCode from "qrcode";
import { loadPhoto, type PhotoOptions, type PhotoSource } from "./photo.js";
import { esc, oneLine, wrap } from "./text.js";

/** Pixel sizes. rect and leader are 2× the standard IAB ad sizes so they stay sharp on retina screens. */
export const BANNERS = {
  square: { w: 1080, h: 1080, label: "Instagram & Facebook post", size: "1080 × 1080" },
  story: { w: 1080, h: 1920, label: "Stories, Reels, TikTok", size: "1080 × 1920" },
  wide: { w: 1200, h: 630, label: "Link post: X, Facebook, LinkedIn, Telegram", size: "1200 × 630" },
  rect: { w: 600, h: 500, label: "Ad on a website", size: "300 × 250 (sharp on retina)" },
  leader: { w: 1456, h: 180, label: "Banner on a website", size: "728 × 90 (sharp on retina)" },
} as const;
export type BannerFormat = keyof typeof BANNERS;
export const isBannerFormat = (f: string): f is BannerFormat => Object.hasOwn(BANNERS, f);

/** Default font stack: Inter if installed (see README), else the platform's sans-serif. */
export const DEFAULT_FONT = "Inter, 'SF Pro Display', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif";

export interface BannerInput {
  /** Product photo: Buffer, file path or http(s) URL. Missing → a dark background. */
  photo?: PhotoSource;
  title: string;
  /** Already formatted, e.g. "25 USDC" or "From $40". */
  price: string;
  store: string;
  /** A short line under the price ("Handmade · ships in 2 days"); can be empty. */
  facts?: string;
  /** Where the QR code points (the item's buy page). */
  url: string;
  /** "service" says "Book now"; anything else "Buy now". */
  kind?: string;
  /** CSS font-family list for the SVG text. Default DEFAULT_FONT. */
  font?: string;
}

export interface RenderOptions extends PhotoOptions {
  /** Text under the price on the card formats. Default "Safe payment · escrow on NEAR". */
  trustLine?: string;
  /** Label above the QR. Default "Scan to buy". */
  scanLabel?: string;
  /** Button labels. Default "Buy now" / "Book now". */
  cta?: { product?: string; service?: string };
  /** Accent colour of the button. Default "#0a84ff". */
  accent?: string;
  /** What to do when the photo can't be loaded: render without it (default) or throw. */
  onPhotoError?: "skip" | "throw";
}

const pillWidth = (label: string, h: number) => Math.round(label.length * h * 0.3 + h * 0.9);

async function photoLayer(photo: Buffer | null, w: number, h: number): Promise<Buffer> {
  if (photo) {
    try { return await sharp(photo).rotate().resize(w, h, { fit: "cover", position: "attention" }).toBuffer(); }
    catch { /* not an image: fall through to the plain background */ }
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: "#1c1c1e" } }).png().toBuffer();
}

async function qr(url: string, size: number): Promise<Buffer> {
  const code = await QRCode.toBuffer(url, { margin: 1, width: size, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  const r = Math.round(size * 0.08);
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#fff"/></svg>`);
  return sharp(code).resize(size, size).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

/** Where the QR sits in each format (null: too small for a QR; the banner itself is the link). */
export function qrBox(f: BannerFormat): { left: number; top: number; size: number } | null {
  const { w, h } = BANNERS[f];
  if (f === "square" || f === "story") {
    const u = w / 1080, pad = Math.round(64 * u), q = Math.round((f === "story" ? 230 : 200) * u);
    return { left: w - pad - q, top: h - pad - q, size: q };
  }
  if (f === "wide") { const pad = 56, q = 170; return { left: w - pad - q, top: h - pad - q, size: q }; }
  return null;
}

/** One banner as PNG. */
export async function renderBanner(f: BannerFormat, a: BannerInput, o: RenderOptions = {}): Promise<Buffer> {
  if (!isBannerFormat(f)) throw new Error(`unknown banner format "${String(f)}"`);
  const { w, h } = BANNERS[f];
  let photo: Buffer | null = null;
  try { photo = await loadPhoto(a.photo, o); }
  catch (e) { if (o.onPhotoError === "throw") throw e; }

  const font = esc(a.font ?? DEFAULT_FONT);
  const text = (x: number, y: number, size: number, weight: number, fill: string, s: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const lines = (x: number, y: number, size: number, weight: number, fill: string, ls: string[], lh = 1.15) =>
    ls.map((l, i) => text(x, y + i * size * lh, size, weight, fill, l)).join("");
  const accent = /^#[0-9a-f]{3,8}$/i.test(o.accent ?? "") ? o.accent! : "#0a84ff";
  const pill = (x: number, y: number, ph: number, label: string, anchorRight = false) => {
    const pw = pillWidth(label, ph), x0 = anchorRight ? x - pw : x;
    return `<rect x="${x0}" y="${y}" width="${pw}" height="${ph}" rx="${ph / 2}" fill="${accent}"/>${text(x0 + pw / 2, y + ph * 0.64, Math.round(ph * 0.42), 650, "#fff", label, 'text-anchor="middle"')}`;
  };
  const cta = a.kind === "service" ? (o.cta?.service ?? "Book now") : (o.cta?.product ?? "Buy now");
  const trust = o.trustLine ?? "Safe payment · escrow on NEAR", scan = o.scanLabel ?? "Scan to buy";
  const facts = a.facts ?? "";

  let photoBuf: Buffer, svg: string;
  if (f === "square" || f === "story") {
    const u = w / 1080, pad = Math.round(64 * u), q = Math.round((f === "story" ? 230 : 200) * u);
    photoBuf = await photoLayer(photo, w, h);
    const titleSize = Math.round((f === "story" ? 84 : 72) * u), title = wrap(a.title, Math.floor((w - pad * 2 - q - 24) / (titleSize * 0.52)), 3);
    const base = h - pad - q;
    // The store name sits on a dark capsule so it reads on any photo.
    const store = oneLine(a.store.toUpperCase(), 28), capH = Math.round(66 * u);
    svg = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".88"/></linearGradient></defs>
      <rect y="${Math.round(h * 0.38)}" width="${w}" height="${Math.round(h * 0.62)}" fill="url(#g)"/>
      <rect x="${pad - 22 * u}" y="${pad - 14 * u}" width="${Math.round(store.length * 34 * u * 0.6 + 44 * u)}" height="${capH}" rx="${capH / 2}" fill="#000" fill-opacity=".55"/>
      ${text(pad, pad + 30 * u, Math.round(30 * u), 650, "#fff", store, 'letter-spacing="2"')}
      ${lines(pad, base - (title.length - 1) * titleSize * 1.1 - 92 * u, titleSize, 750, "#fff", title, 1.1)}
      ${text(pad, base + 6 * u, Math.round(54 * u), 700, "#fff", oneLine(a.price, 24))}
      ${text(pad, base + 60 * u, Math.round(32 * u), 450, "#fff", oneLine(facts, 40), 'opacity=".8"')}
      ${pill(pad, h - pad - Math.round(86 * u), Math.round(86 * u), cta)}
      ${text(w - pad - q / 2, h - pad - q - 18 * u, Math.round(26 * u), 600, "#fff", scan, 'text-anchor="middle" opacity=".9"')}
      ${text(pad + pillWidth(cta, Math.round(86 * u)) + 24 * u, h - pad - 30 * u, Math.round(28 * u), 500, "#fff", trust, 'opacity=".8"')}`;
  } else if (f === "wide") {
    const half = 600, pad = 56, q = 170;
    photoBuf = await photoLayer(photo, half, h);
    svg = `<rect x="${half}" width="${w - half}" height="${h}" fill="#111113"/>
      ${text(half + pad, pad + 26, 26, 650, "#8e8e93", oneLine(a.store.toUpperCase(), 30), 'letter-spacing="2"')}
      ${lines(half + pad, pad + 100, 52, 750, "#fff", wrap(a.title, 18, 3), 1.12)}
      ${text(half + pad, h - pad - 150, 44, 700, "#fff", oneLine(a.price, 20))}
      ${text(half + pad, h - pad - 108, 24, 450, "#a1a1a6", oneLine(facts, 26))}
      ${pill(half + pad, h - pad - 70, 70, cta)}
      ${text(w - pad - q / 2, h - pad - q - 14, 20, 600, "#a1a1a6", scan, 'text-anchor="middle"')}`;
  } else if (f === "rect") {
    const ph = 290, pad = 28;
    photoBuf = await photoLayer(photo, w, ph);
    // The button is anchored to the right edge, level with the price (left-anchored it covered the price).
    svg = `<rect y="${ph}" width="${w}" height="${h - ph}" fill="#111113"/>
      ${text(pad, ph + 52, 36, 750, "#fff", oneLine(a.title, 26))}
      ${text(pad, ph + 96, 30, 700, "#fff", oneLine(a.price, 18))}
      ${text(pad, ph + 140, 22, 500, "#a1a1a6", oneLine(a.store, 20))}
      ${text(pad, ph + 172, 20, 500, "#a1a1a6", oneLine(trust, 30))}
      ${pill(w - pad, ph + 104, 60, cta, true)}`;
  } else {
    const pad = 28;
    photoBuf = await photoLayer(photo, h, h);
    svg = `<rect x="${h}" width="${w - h}" height="${h}" fill="#111113"/>
      ${text(h + pad, 66, 46, 750, "#fff", oneLine(a.title, 34))}
      ${text(h + pad, 124, 30, 500, "#a1a1a6", oneLine(`${a.price} · ${a.store} · ${o.trustLine ?? "safe payment on NEAR"}`, 52))}
      ${pill(w - pad, (h - 84) / 2, 84, cta, true)}`;
  }
  // Order: photo → gradient and text → QR on top.
  const layers: sharp.OverlayOptions[] = [
    { input: photoBuf, top: 0, left: 0 },
    { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`), top: 0, left: 0 },
  ];
  const box = qrBox(f);
  if (box) layers.push({ input: await qr(a.url, box.size), top: box.top, left: box.left });
  return sharp({ create: { width: w, height: h, channels: 3, background: "#000" } }).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}
