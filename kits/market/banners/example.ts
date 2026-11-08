// npx tsx example.ts   — writes the 5 banner formats to ./out.
// Optional env: PHOTO=path-or-url to a product photo, URL=where the QR points, FONT="Inter, sans-serif".
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { BANNERS, renderBanner, type BannerFormat } from "./src/index.js";

// Without PHOTO, a made-up "product photo" (a warm gradient with a circle) stands in.
const demoPhoto = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
  <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4c27a"/><stop offset="1" stop-color="#b8572b"/></linearGradient></defs>
  <rect width="1200" height="1200" fill="url(#a)"/><circle cx="600" cy="560" r="300" fill="#f7efe4"/><circle cx="600" cy="560" r="230" fill="#6b3a24"/></svg>`)).jpeg().toBuffer();

const input = {
  photo: process.env.PHOTO ?? await demoPhoto(),
  title: "Hand-thrown ceramic mug, speckled glaze",
  price: "25 USDC",
  store: "Clay & Co",
  facts: "Handmade · ships in 2 days",
  url: process.env.URL ?? "https://example.com/shop/clay/mug?ref=banner",
  kind: "product",
  ...(process.env.FONT ? { font: process.env.FONT } : {}),
};

await mkdir("out", { recursive: true });
for (const f of Object.keys(BANNERS) as BannerFormat[]) {
  const t = Date.now();
  const png = await renderBanner(f, input);
  await writeFile(`out/${f}.png`, png);
  console.log(`out/${f}.png  ${BANNERS[f].w}×${BANNERS[f].h}  ${(png.length / 1024).toFixed(0)} KB  ${Date.now() - t} ms  — ${BANNERS[f].label}`);
}
