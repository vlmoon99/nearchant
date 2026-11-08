import { describe, expect, it } from "vitest";
import { alignToScript, assColor, assSubtitles, balance, captionChunks, composeArgs, onColor, pickAccent, pingpongArgs, totalSeconds } from "../src/index.js";

const w = (word: string, start: number, end: number) => ({ word, start, end });

describe("alignToScript", () => {
  it("shows the script's words on whisper's timing (whisper misheard 'Soho' as 'so ho')", () => {
    const heard = [w("Made", 0, 0.3), w("in", 0.3, 0.4), w("so", 0.4, 0.6), w("ho.", 0.6, 0.9)];
    const out = alignToScript(heard, "Made in SoHo.");
    expect(out.map((x) => x.word)).toEqual(["Made", "in", "SoHo."]);
    expect(out[0]!.start).toBe(0);
    expect(out.at(-1)!.end).toBeCloseTo(0.9);
  });
  it("keeps one-to-one timing when the counts match", () => {
    expect(alignToScript([w("Hi", 0, 0.5), w("you", 0.5, 1)], "Hey you")).toEqual([w("Hey", 0, 0.5), w("you", 0.5, 1)]);
  });
});

describe("captionChunks", () => {
  it("cuts at 3 words, 18 characters, punctuation and pauses; never overlaps", () => {
    const c = captionChunks([w("Soft", 0, 0.3), w("linen", 0.3, 0.6), w("meets", 0.6, 0.9), w("warm", 0.9, 1.2), w("knit.", 1.2, 1.6), w("Tap", 2.6, 2.8), w("now", 2.8, 3)]);
    expect(c.map((x) => x.text)).toEqual(["Soft linen meets", "warm knit.", "Tap now"]); // 1 s pause → new chunk
    expect(c[0]!.end).toBeCloseTo(0.9);
    expect(c[1]!.end).toBeLessThanOrEqual(c[2]!.start);
  });
});

describe("brand accent", () => {
  it("picks the most vivid brand colour, skipping near-black and near-white", () => {
    expect(pickAccent(["#1C2A3A", "#F5F2EB", "#A83232", "#2E5C8A", "#D4B896"])).toBe("#A83232");
    expect(pickAccent(["#000000", "#FFFFFF"])).toBe("#007AFF");
    expect(onColor("#A83232")).toBe("#FFFFFF");
    expect(onColor("#F5D76E")).toBe("#111111");
    expect(assColor("#A83232")).toBe("&H003232A8");
    expect(assColor("#000000", 0xa0)).toBe("&HA0000000");
  });
  it("balances a hook over two lines", () => {
    expect(balance("RAW DENIM TRUTH")).toBe("RAW DENIM\\NTRUTH");
    expect(balance("SHORT")).toBe("SHORT");
  });
});

describe("assSubtitles", () => {
  const o = { hook: "Raw denim {\\b0}truth", words: [w("Hi{x}", 0, 0.5)], voiceEnd: 6, accent: "#A83232", store: "Nova Wear NYC", cta: "Tap the link to shop", link: "novawear.nearchant.com" };
  it("hook on a brand-colour box, captions on a dark pill at ~70% height, then the end-card", () => {
    const s = assSubtitles(o);
    expect(s).toContain("Style: Hook,Montserrat ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H003232A8");
    expect(s).toMatch(/Style: Cap,Montserrat ExtraBold,62,&H00FFFFFF,&H00FFFFFF,&H38000000,[^\n]*,3,14,0,2,80,80,384,1/);
    expect(s).toContain("{\\fad(120,200)}RAW DENIM\\NB0TRUTH");
    expect(s).toContain("Cap,,0,0,0,,Hix");
    expect(s).toContain("Dialogue: 2,0:00:06.40,0:00:07.90,Card");
    expect(s).toContain("\\1c&H3232A8&");
    expect(s).toContain("Nova Wear NYC");
    expect(s).toContain("novawear.nearchant.com");
  });
  it("no end-card without a store name", () => {
    expect(assSubtitles({ ...o, store: undefined })).not.toContain(",Card,,");
  });
});

describe("composeArgs", () => {
  it("loops the clip under the voice with an explicit length and escapes filter paths", () => {
    const a = composeArgs({ clip: "/m/c.webm", voice: "/m/v.wav", ass: "/m/it's:x.ass", fontsDir: "/app/assets/fonts", out: "/m/o.mp4", seconds: totalSeconds(7.3, true) });
    expect(a.slice(a.indexOf("-stream_loop"), a.indexOf("-stream_loop") + 4)).toEqual(["-stream_loop", "-1", "-i", "/m/c.webm"]);
    expect(a[a.indexOf("-t") + 1]).toBe("9.20");                     // 7.3 voice + 0.4 tail + 1.5 end-card
    expect(a[a.indexOf("-filter_complex") + 1]).toContain("subtitles=filename='/m/it\\'s\\:x.ass'");
    expect(a[a.indexOf("-filter_complex") + 1]).toContain("apad[a]");  // silence under the end-card
    expect(totalSeconds(40, true)).toBe(13.9);                          // voice capped at 12 s
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
