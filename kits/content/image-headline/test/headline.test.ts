import { describe, expect, it } from "vitest";
import { addHeadline, assColor, balance, filterPath, headlineArgs, headlineAss, imageSize, onColor, pickAccent } from "../src/index.js";

describe("colours", () => {
  it("picks the most vivid brand colour, skipping near-white/near-black and greys", () => {
    expect(pickAccent(["#FFFFFF", "#111111", "#808080", "#3366cc", "#E63946"])).toBe("#E63946");
    expect(pickAccent(["#fafafa", "#050505"])).toBe("#007AFF");
    expect(pickAccent(["#777777"], "#00AA00")).toBe("#00AA00");
    expect(pickAccent(["not a colour", "e63946"])).toBe("#E63946");
    expect(pickAccent(undefined)).toBe("#007AFF");
  });
  it("writes ASS colours as &HAABBGGRR", () => {
    expect(assColor("#E63946")).toBe("&H004639E6");
    expect(assColor("#000000", 0xa0)).toBe("&HA0000000");
  });
  it("chooses readable text on the accent", () => {
    expect(onColor("#FFD60A")).toBe("#111111");
    expect(onColor("#1D3557")).toBe("#FFFFFF");
  });
});

describe("wrapping", () => {
  it("leaves short text on one line", () => {
    expect(balance("NEW IN")).toBe("NEW IN");
    expect(balance("SUPERCALIFRAGILISTIC")).toBe("SUPERCALIFRAGILISTIC");
  });
  it("splits longer text into two balanced lines", () => {
    expect(balance("FRESH LINEN FOR HOT DAYS")).toBe("FRESH LINEN\\NFOR HOT DAYS");
    const [a, b] = balance("HANDMADE CERAMIC MUGS GLAZED IN OCEAN BLUE").split("\\N");
    expect(Math.abs(a!.length - b!.length)).toBeLessThanOrEqual(6);
  });
});

describe("headlineAss", () => {
  const ass = headlineAss("  fresh {\\b1}linen\nfor hot days ", 1024, 1280, "#E63946");
  it("is a valid ASS script sized to the picture", () => {
    expect(ass).toContain("PlayResX: 1024\nPlayResY: 1280");
    expect(ass).toMatch(/\[V4\+ Styles\][\s\S]*\[Events\]/);
  });
  it("strips override braces and backslashes, upper-cases and wraps", () => {
    expect(ass).toContain(",FRESH B1LINEN\\NFOR HOT DAYS\n");
    expect(ass).not.toContain("{\\b1}");
  });
  it("draws the band in the accent across the bottom, text in the readable colour", () => {
    const size = Math.round(1024 * 0.078), strip = Math.round(size * (1.25 * 2 + 1.1));
    expect(ass).toContain(`\\pos(0,${1280 - strip})`);
    expect(ass).toContain(`m 0 0 l 1024 0 l 1024 ${strip} l 0 ${strip}`);
    expect(ass).toContain("\\1c&H4639E6&");
    expect(ass).toContain(`Style: Strip,Montserrat ExtraBold,${size},&H00FFFFFF,`);
  });
  it("takes a font, a size and keeps case when asked", () => {
    const a = headlineAss("Hi there", 500, 500, "#FFD60A", { font: "Inter Black", sizeOfWidth: 0.1, upper: false });
    expect(a).toContain("Style: Strip,Inter Black,50,&H00111111,");
    expect(a).toContain(",Hi there\n");
  });
  it("rejects a bad accent or size", () => {
    expect(() => headlineAss("x", 100, 100, "red")).toThrow(/RRGGBB/);
    expect(() => headlineAss("x", 0, 100, "#FF0000")).toThrow();
  });
});

describe("imageSize", () => {
  it("reads PNG", () => {
    const b = new Uint8Array(24); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(b.buffer); v.setUint32(16, 1024); v.setUint32(20, 1280);
    expect(imageSize(b)).toEqual({ width: 1024, height: 1280 });
  });
  it("reads JPEG (skipping an APP0 segment)", () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x00, 0x02, 0xd0, 0x03, 0, 0, 0, 0]);
    expect(imageSize(b)).toEqual({ width: 720, height: 1280 });
  });
  it("refuses other data", () => { expect(() => imageSize(new Uint8Array([1, 2, 3]))).toThrow(/PNG or JPEG/); });
});

describe("ffmpeg arguments", () => {
  it("escapes paths for the filter", () => {
    expect(filterPath("C:\\fonts\\it's")).toBe("C\\:\\\\fonts\\\\it\\'s");
    expect(headlineArgs({ input: "a.png", output: "b.png", ass: "/t/s.ass", fontsDir: "/f" })).toEqual(
      ["-y", "-hide_banner", "-loglevel", "error", "-i", "a.png", "-vf", "subtitles=filename='/t/s.ass':fontsdir='/f'", "-frames:v", "1", "b.png"]);
  });
  it("says clearly when ffmpeg is missing (failure path)", async () => {
    const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47]); new DataView(png.buffer).setUint32(16, 10); new DataView(png.buffer).setUint32(20, 10);
    await expect(addHeadline(png, "x", { fontsDir: "/nope", ffmpeg: "/definitely/not/ffmpeg" })).rejects.toThrow(/not found/);
  });
});
