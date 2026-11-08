// Same input → same file: banners are rendered once and read from disk after that.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPhoto } from "./photo.js";
import { renderBanner, type BannerFormat, type BannerInput, type RenderOptions } from "./banners.js";

/** Bump when the drawing code changes so old files aren't served. */
const VERSION = 1;

/**
 * Cache key for a banner: format + text + render options + the photo. A Buffer or file path is hashed by its bytes
 * (a changed file gives a new banner); a URL by the URL itself (no download on a cache hit — put a version in your
 * photo URLs if they change).
 */
export async function bannerKey(f: BannerFormat, a: BannerInput, o: RenderOptions = {}): Promise<{ key: string; photo: Buffer | string | null }> {
  let photoId = "", photo: Buffer | string | null = null;
  if (typeof a.photo === "string" && /^https?:\/\//i.test(a.photo)) { photoId = `url:${a.photo}`; photo = a.photo; }
  else if (a.photo != null && a.photo !== "") {
    photo = await loadPhoto(a.photo, o).catch(() => null);
    photoId = photo ? `sha256:${createHash("sha256").update(photo).digest("hex")}` : "missing";
  }
  const { fetch: _f, ...opts } = o;
  const text = { title: a.title, price: a.price, store: a.store, facts: a.facts ?? "", url: a.url, kind: a.kind ?? "", font: a.font ?? "" };
  const key = createHash("sha256").update(JSON.stringify({ v: VERSION, f, text, opts, photoId })).digest("hex").slice(0, 20);
  return { key, photo };
}

/** Renders a banner or reads it from `dir` (created if missing). Returns the PNG and its file path. */
export async function cachedBanner(dir: string, f: BannerFormat, a: BannerInput, o: RenderOptions = {}): Promise<{ png: Buffer; file: string; hit: boolean }> {
  const { key, photo } = await bannerKey(f, a, o);
  const file = join(dir, `${f}-${key}.png`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return { png: cached, file, hit: true };
  const png = await renderBanner(f, { ...a, photo }, o);
  await mkdir(dir, { recursive: true });
  // Write then rename, so a reader never sees half a file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return { png, file, hit: false };
}
