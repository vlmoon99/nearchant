import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BANNERS, renderBanner, wrap, type BannerFormat } from "../src/banners.js";

describe("banners (ADR 0027)", () => {
  it("wraps a title into lines and ends a cut one with …", () => {
    expect(wrap("Black Crystal Smartphone with gold plate", 19, 3)).toEqual(["Black Crystal", "Smartphone with", "gold plate"]);
    expect(wrap("one two three four five six seven", 9, 2)).toEqual(["one two", "three…"]);
  });
  it("renders every format at its exact size, with or without a photo", async () => {
    const photo = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#884422" } }).jpeg().toBuffer();
    for (const f of Object.keys(BANNERS) as BannerFormat[]) {
      const png = await renderBanner(f, { photo: f === "rect" ? null : photo, title: "Gold & <diamond> phone", price: "10 nUSD", store: "VIP Electronics", facts: "In stock", url: "https://nearchant.com/h/vip/i/i-1?ref=banner", kind: "product" });
      const m = await sharp(png).metadata();
      expect([f, m.format, m.width, m.height]).toEqual([f, "png", BANNERS[f].w, BANNERS[f].h]);
    }
  });
});
