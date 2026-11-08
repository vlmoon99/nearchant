# Banners

Ready-to-post images of a product or service — photo, name, price, the store and a QR code that opens it to buy — in
the five sizes sellers actually need, as PNG.

## Copy it

```sh
cp -r kits/market/banners ./src/banners
npm i sharp qrcode
```

```ts
import { renderBanner, cachedBanner, BANNERS, isBannerFormat } from "./banners/src/index.js";
```

## Use it

```ts
const png = await renderBanner("square", {
  photo: "https://cdn.example.com/mug.jpg",   // Buffer, file path or URL; missing → dark background
  title: "Hand-thrown ceramic mug",
  price: "25 USDC",
  store: "Clay & Co",
  facts: "Handmade · ships in 2 days",
  url: "https://example.com/shop/clay/mug?ref=banner",   // what the QR opens
  kind: "product",                                     // "service" → "Book now"
});
await writeFile("mug-square.png", png);

// In a web route: render once, then serve from disk
app.get("/banners/:item/:format", async (c) => {
  const f = c.req.param("format");
  if (!isBannerFormat(f)) return c.notFound();
  const { png } = await cachedBanner("./media/banners", f, await bannerInputFor(c.req.param("item")));
  return c.body(png, 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
});
```

`npx tsx example.ts` writes all five to `./out` (`PHOTO=…`, `URL=…`, `FONT=…` to try your own).

## Options

| Format | Pixels | For | QR |
| --- | --- | --- | --- |
| `square` | 1080 × 1080 | Instagram & Facebook post | yes |
| `story` | 1080 × 1920 | Stories, Reels, TikTok | yes |
| `wide` | 1200 × 630 | Link post: X, Facebook, LinkedIn, Telegram | yes |
| `rect` | 600 × 500 | Website ad, shown at 300 × 250 | no (too small; link the image) |
| `leader` | 1456 × 180 | Website banner, shown at 728 × 90 | no |

`renderBanner(format, input, options)`:

| Field / option | Default | What it does |
| --- | --- | --- |
| `input.photo` | — | Buffer, file path or http(s) URL |
| `input.title`, `price`, `store`, `url` | — | Text and the QR target (already formatted: the kit does no currency maths) |
| `input.facts` | `""` | Short line under the price |
| `input.kind` | `"product"` | `"service"` uses the service button label |
| `input.font` | `DEFAULT_FONT` | CSS font-family list (Inter first, then system sans-serif) |
| `trustLine` | `"Safe payment · escrow on NEAR"` | Line next to the button |
| `scanLabel` | `"Scan to buy"` | Above the QR |
| `cta` | `{ product: "Buy now", service: "Book now" }` | Button labels |
| `accent` | `#0a84ff` | Button colour (hex) |
| `onPhotoError` | `"skip"` | `"throw"` to fail instead of rendering without the photo |
| `timeoutMs`, `retries`, `maxBytes`, `fetch` | 10 s, 2, 20 MB, global | Photo download (retries network errors, 5xx, 429 with backoff; not 404) |

`cachedBanner(dir, format, input, options)` → `{ png, file, hit }`. Files are `<format>-<hash>.png`; the hash covers the
format, all text, the options and the photo (bytes for a Buffer or file, the URL string for a URL — no download on a
hit). Write is temp-file + rename. Old files are never deleted; clear the folder when you like.
Also exported: `BANNERS`, `isBannerFormat`, `qrBox(format)`, `wrap`, `loadPhoto`, `bannerKey`.

### Fonts

Text is drawn by librsvg (inside sharp) with whatever fonts fontconfig finds. The design was made for **Inter**:

- Debian/Ubuntu (and Docker `node:*-slim`): `apt-get install -y fonts-inter` (add `fontconfig` on slim images)
- macOS: `brew install --cask font-inter`
- Anywhere: put `Inter*.ttf` in `~/.fonts` (Linux) and run `fc-cache -f`

Without it the stack falls back to SF Pro / Helvetica / Arial / DejaVu Sans. A bare container with no fonts at all
renders boxes instead of letters — install at least one font.

## How it works

One `sharp` composite per banner: the photo (cropped with `fit: cover, position: attention`, EXIF-rotated) → an SVG
layer with a dark gradient or panel, the text, the store name on a dark capsule (readable on any photo) and the
button → the QR (`qrcode`, error correction M, rounded corners) on top. Text is escaped and line-wrapped by character
count (`wrap`), with `…` when cut — there are no font metrics, so very wide fonts can run closer to the edges.

## Tested

31 Vitest tests: every format is a PNG of the exact size; the QR decodes (with `jsqr`) to the `url` on square,
story and wide; renders with no photo, a missing file, a non-image Buffer and a failing URL; the photo really appears;
file-path photos; long titles, markup characters, emoji and odd fonts; service vs product button; unknown format;
`wrap` edge cases; photo download retries, no retry on 404, size cap, timeout signal; cache hit/miss, key changes,
no download on a URL hit. Not tested: how text looks with each font (checked by eye on macOS with system fonts
via `example.ts`; Nearchant runs it with Inter in Docker).

## Came from

Nearchant, ADR 0027 (`docs/adr/0027-banners-and-buy-widget.md`): `apps/gateway/src/banners.ts`, cached per item
in `apps/gateway/src/main.ts` (`banner:`), shown on the seller app's Share pages. Inter comes from `fonts-inter` in
`deploy/Dockerfile`.
