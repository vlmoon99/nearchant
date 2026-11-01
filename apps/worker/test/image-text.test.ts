import { describe, expect, it } from "vitest";
import { NO_TEXT, headlineAss } from "../src/image-text.js";

describe("headline strip", () => {
  it("is a bottom strip in the brand colour with readable text, sized to the picture", () => {
    const s = headlineAss("Layers for {city} days", 1024, 1280, "#A83232");
    expect(s).toContain("PlayResX: 1024\nPlayResY: 1280");
    expect(s).toContain("\\1c&H3232A8&");
    expect(s).toContain("LAYERS FOR\\NCITY DAYS");
    expect(s).toMatch(/Style: Strip,Montserrat ExtraBold,63,&H00FFFFFF/);
    expect(NO_TEXT).toMatch(/No text/);
  });
});
