import { describe, expect, it } from "vitest";
import { assSubtitles, captionChunks, composeArgs, pingpongArgs } from "../src/video-compose.js";

const w = (word: string, start: number, end: number) => ({ word, start, end });

describe("captionChunks", () => {
  it("cuts at 3 words, 18 characters and punctuation", () => {
    const c = captionChunks([w("Soft", 0, 0.3), w("linen", 0.3, 0.6), w("meets", 0.6, 0.9), w("warm", 0.9, 1.2), w("knit.", 1.2, 1.6), w("Extraordinarily", 2, 2.8), w("comfortable", 2.8, 3.4)]);
    expect(c.map((x) => x.text)).toEqual(["Soft linen meets", "warm knit.", "Extraordinarily", "comfortable"]);
    expect(c[0]!.end).toBeCloseTo(0.9); // held until the next chunk starts
    expect(c[1]!.end).toBeCloseTo(2);
  });
});

describe("assSubtitles", () => {
  it("puts the hook on top and strips ASS override characters", () => {
    const s = assSubtitles("Layers {\\b0}for autumn", [w("Hi{x}", 0, 0.5)]);
    expect(s).toContain("Hook,,0,0,0,,{\\fad(150,250)}LAYERS B0FOR AUTUMN");
    expect(s).toContain("Cap,,0,0,0,,Hix");
    expect(s).toContain("PlayResY: 1280");
  });
});

describe("composeArgs", () => {
  it("loops the clip under the voice with a hard length cap and escapes filter paths", () => {
    const a = composeArgs({ clip: "/m/c.webm", voice: "/m/v.wav", ass: "/m/it's:x.ass", fontsDir: "/app/assets/fonts", out: "/m/o.mp4", seconds: 9.5 });
    expect(a.slice(a.indexOf("-stream_loop"), a.indexOf("-stream_loop") + 4)).toEqual(["-stream_loop", "-1", "-i", "/m/c.webm"]);
    expect(a[a.indexOf("-t") + 1]).toBe("10.10");
    expect(composeArgs({ clip: "c", voice: "v", ass: "a", fontsDir: "f", out: "o", seconds: 40 })[a.indexOf("-t") + 1]).toBe("20.00");
    expect(a[a.indexOf("-filter_complex") + 1]).toContain("subtitles=filename='/m/it\\'s\\:x.ass'");
  });
});

describe("pingpongArgs", () => {
  it("plays the clip forward then reversed, without audio", () => {
    const a = pingpongArgs("/m/c.webm", "/m/c-pingpong.mp4");
    expect(a[a.indexOf("-filter_complex") + 1]).toBe("[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]");
    expect(a).toContain("-an");
    expect(a.at(-1)).toBe("/m/c-pingpong.mp4");
  });
});
