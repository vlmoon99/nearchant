import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsqr from "jsqr";
// jsqr is CommonJS with a `default` export; under NodeNext the callable is on .default.
const jsQR = (jsqr as unknown as { default: typeof jsqr.default }).default ?? (jsqr as unknown as typeof jsqr.default);
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BANNERS, cachedBanner, isBannerFormat, loadPhoto, qrBox, renderBanner, wrap, type BannerFormat, type BannerInput } from "../src/index.js";

const FORMATS = Object.keys(BANNERS) as BannerFormat[];
const input: BannerInput = { title: "Hand-thrown ceramic mug", price: "25 USDC", store: "Clay & Co", facts: "Handmade · ships in 2 days", url: "https://example.com/h/clay/i/mug?ref=banner", kind: "product" };
let photo: Buffer, dir: string;

beforeAll(async () => {
  // A plain orange "photo", so the photo layer is easy to see in the pixels.
  photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#e07a2f" } }).jpeg().toBuffer();
  dir = await mkdtemp(join(tmpdir(), "banners-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const decodeQr = async (png: Buffer, f: BannerFormat) => {
  const box = qrBox(f)!;
  const pad = 20; // jsQR wants some quiet zone around the code
  const { data, info } = await sharp(png).extract({ left: box.left - pad, top: box.top - pad, width: box.size + 2 * pad, height: box.size + 2 * pad })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)?.data ?? null;
};

describe("renderBanner", () => {
  it.each(FORMATS)("%s is a PNG of the right size", async (f) => {
    const png = await renderBanner(f, { ...input, photo });
    const m = await sharp(png).metadata();
    expect(m.format).toBe("png");
    expect([m.width, m.height]).toEqual([BANNERS[f].w, BANNERS[f].h]);
  });

  it.each(["square", "story", "wide"] as const)("%s has a QR code that opens the url", async (f) => {
    const png = await renderBanner(f, { ...input, photo });
    expect(await decodeQr(png, f)).toBe(input.url);
  });

  it("rect and leader have no QR (too small); the banner itself is the link", () => {
    expect(qrBox("rect")).toBeNull();
    expect(qrBox("leader")).toBeNull();
  });

  it.each(FORMATS)("%s renders without a photo", async (f) => {
    const png = await renderBanner(f, { ...input, photo: null });
    expect((await sharp(png).metadata()).width).toBe(BANNERS[f].w);
  });

  it("uses the photo: the top-left area takes its colour", async () => {
    // stats() looks at the whole input, so cut the area out first.
    const stats = async (png: Buffer) => sharp(await sharp(png).extract({ left: 300, top: 300, width: 100, height: 100 }).toBuffer()).stats();
    const withPhoto = await stats(await renderBanner("square", { ...input, photo }));
    const without = await stats(await renderBanner("square", { ...input, photo: null }));
    expect(withPhoto.channels[0]!.mean).toBeGreaterThan(180); // orange
    expect(without.channels[0]!.mean).toBeLessThan(60); // dark background
  });

  it("still renders when the photo can't be loaded, or throws if asked", async () => {
    const broken = { ...input, photo: join(dir, "nope.jpg") };
    expect((await sharp(await renderBanner("wide", broken)).metadata()).width).toBe(1200);
    await expect(renderBanner("wide", broken, { onPhotoError: "throw" })).rejects.toThrow(/ENOENT/);
    const notAnImage = { ...input, photo: Buffer.from("definitely not a jpeg") };
    expect((await sharp(await renderBanner("rect", notAnImage)).metadata()).width).toBe(600);
  });

  it("reads a photo from a file path", async () => {
    const file = join(dir, "photo.jpg");
    await writeFile(file, photo);
    const png = await renderBanner("square", { ...input, photo: file });
    expect((await sharp(await sharp(png).extract({ left: 300, top: 300, width: 50, height: 50 }).toBuffer()).stats()).channels[0]!.mean).toBeGreaterThan(180);
  });

  it("survives long titles, markup characters, emoji and an empty facts line", async () => {
    const odd = { ...input, title: `<script>alert("x")</script> & ${"Very long product name ".repeat(20)} 🍵`, store: "A & B's \"Store\" " + "x".repeat(80), facts: "", font: "My \"Font\", sans-serif" };
    for (const f of FORMATS) expect((await sharp(await renderBanner(f, odd)).metadata()).height).toBe(BANNERS[f].h);
  });

  it("says Book now for services (options can change the labels)", async () => {
    // Not readable from pixels without OCR: check the button got wider for a longer label instead.
    const btn = async (label: string | null, kind = "product") => {
      const png = await renderBanner("rect", { ...input, kind }, label ? { cta: { product: label } } : {});
      const { data, info } = await sharp(png).extract({ left: 0, top: 394, width: 600, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let x = 0; x < info.width; x++) { const i = x * info.channels; if (data[i]! < 40 && data[i + 1]! > 100 && data[i + 2]! > 200) n++; }
      return n; // blue pixels on one row through the button
    };
    expect(await btn(null, "service")).toBeGreaterThan(await btn(null)); // "Book now" is one letter longer than "Buy now"
    expect(await btn("Buy this lovely mug now")).toBeGreaterThan(await btn("Buy"));
  });

  it("refuses an unknown format", async () => {
    await expect(renderBanner("poster" as BannerFormat, input)).rejects.toThrow(/unknown banner format/);
    expect(isBannerFormat("square")).toBe(true);
    expect(isBannerFormat("poster")).toBe(false);
    expect(isBannerFormat("toString")).toBe(false);
  });
});

describe("wrap", () => {
  it("keeps short text on one line", () => expect(wrap("Ceramic mug", 20, 3)).toEqual(["Ceramic mug"]));
  it("breaks at word boundaries within the width", () => {
    const ls = wrap("Hand thrown ceramic mug with a speckled glaze", 16, 3);
    expect(ls).toEqual(["Hand thrown", "ceramic mug with", "a speckled glaze"]);
    expect(ls.every((l) => l.length <= 16)).toBe(true);
  });
  it("ends a cut title with …", () => {
    const ls = wrap("one two three four five six seven eight nine ten eleven twelve", 10, 2);
    expect(ls).toHaveLength(2);
    expect(ls[1]!.endsWith("…")).toBe(true);
    expect(ls.every((l) => l.length <= 10)).toBe(true);
  });
  it("cuts a single very long word", () => expect(wrap("Supercalifragilisticexpialidocious", 10, 2)).toEqual(["Supercali…"]));
  it("handles empty and whitespace", () => {
    expect(wrap("", 10, 2)).toEqual([]);
    expect(wrap("  a   b  ", 10, 2)).toEqual(["a b"]);
  });
});

describe("loadPhoto", () => {
  const res = (status: number, body = "img") => new Response(body, { status });
  it("downloads a URL, retrying 5xx and network errors", async () => {
    let n = 0;
    const fetch = (async () => { n++; if (n === 1) throw new TypeError("fetch failed"); if (n === 2) return res(503); return res(200, "jpegbytes"); }) as typeof globalThis.fetch;
    expect((await loadPhoto("https://cdn.example/p.jpg", { fetch }))!.toString()).toBe("jpegbytes");
    expect(n).toBe(3);
  });
  it("does not retry a 404, gives up after retries, refuses huge photos", async () => {
    let n = 0;
    await expect(loadPhoto("https://x/p.jpg", { fetch: (async () => { n++; return res(404); }) as typeof fetch })).rejects.toThrow(/HTTP 404/);
    expect(n).toBe(1);
    n = 0;
    await expect(loadPhoto("https://x/p.jpg", { retries: 1, fetch: (async () => { n++; return res(500); }) as typeof fetch })).rejects.toThrow(/HTTP 500/);
    expect(n).toBe(2);
    await expect(loadPhoto("https://x/p.jpg", { maxBytes: 3, fetch: (async () => res(200, "too big")) as typeof fetch })).rejects.toThrow(/larger than/);
  });
  it("passes a timeout signal to fetch", async () => {
    let signal: AbortSignal | null | undefined;
    await loadPhoto("https://x/p.jpg", { fetch: (async (_u: unknown, init?: RequestInit) => { signal = init?.signal; return res(200); }) as typeof fetch });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it("a URL photo that fails still renders a banner", async () => {
    const png = await renderBanner("square", { ...input, photo: "https://x/p.jpg" }, { retries: 0, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect((await sharp(png).metadata()).width).toBe(1080);
  });
});

describe("cachedBanner", () => {
  it("renders once, then reads from disk; any change gives a new file", async () => {
    const d = join(dir, "cache");
    const a = await cachedBanner(d, "wide", { ...input, photo });
    const b = await cachedBanner(d, "wide", { ...input, photo: Buffer.from(photo) });
    expect([a.hit, b.hit]).toEqual([false, true]);
    expect(b.file).toBe(a.file);
    expect(b.png.equals(a.png)).toBe(true);
    const c = await cachedBanner(d, "wide", { ...input, photo, price: "30 USDC" });
    const e = await cachedBanner(d, "square", { ...input, photo });
    const g = await cachedBanner(d, "wide", { ...input, photo: null });
    expect(new Set([a.file, c.file, e.file, g.file]).size).toBe(4);
    expect((await readdir(d)).filter((f) => f.endsWith(".png"))).toHaveLength(4);
    expect((await readdir(d)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
  it("keys a URL photo by its URL (no download on a hit)", async () => {
    const d = join(dir, "cache-url");
    let n = 0;
    const fetch = (async () => { n++; return new Response(new Uint8Array(photo)); }) as typeof globalThis.fetch;
    await cachedBanner(d, "rect", { ...input, photo: "https://cdn.example/p.jpg" }, { fetch });
    const again = await cachedBanner(d, "rect", { ...input, photo: "https://cdn.example/p.jpg" }, { fetch });
    expect(again.hit).toBe(true);
    expect(n).toBe(1);
  });
});
