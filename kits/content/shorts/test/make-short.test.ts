import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeShort, type Ask, type ClipMaker, type Tts } from "../src/index.js";

const script = { hook: "Linen for hot days", voiceover: "Cool and soft. Tap the link to get yours.", video_prompt: "Slow push-in." };
const tts: Tts = async () => ({ audio: new Uint8Array([1, 2]), seconds: 3.2, words: [{ word: "Cool", start: 0, end: 0.4 }, { word: "and", start: 0.4, end: 0.6 }, { word: "soft.", start: 0.6, end: 1 }] });
const clip: ClipMaker = async () => new Uint8Array([9]);

describe("makeShort (ffmpeg replaced by a recorder)", () => {
  it("runs script → clip ‖ voice → subtitles → pingpong → compose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "short-test-"));
    const runs: string[][] = [], steps: string[] = [];
    let ass = "";
    const ask: Ask = async () => script;
    const r = await makeShort({
      picture: new Uint8Array([7]), ask, about: "Nova Wear, linen clothes", caption: "New linen", tts, clip, fontsDir: "/fonts", out: join(dir, "out.mp4"),
      brandColors: ["#A83232"], store: "Nova Wear", link: "nova.example", workDir: join(dir, "work"),
      run: async (args) => { runs.push(args); if (args.includes("-stream_loop")) ass = await readFile(join(dir, "work", "subs.ass"), "utf8"); },
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(["script", "clip+voice", "compose"]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]");
    expect(runs[1]![runs[1]!.indexOf("-t") + 1]).toBe("5.10"); // 3.2 + 0.4 tail + 1.5 end-card
    expect(r).toMatchObject({ seconds: 5.1, voiceSeconds: 3.2, script });
    expect(ass).toContain("LINEN FOR\\NHOT DAYS");
    expect(ass).toContain("Tap the link to shop");
    expect(ass).toContain("\\1c&H3232A8&");
    expect(existsSync(join(dir, "work", "voice.wav"))).toBe(true); // own workDir is kept
    await rm(dir, { recursive: true, force: true });
  });

  it("cleans up its temp folder and passes a ready script straight through", async () => {
    let work = "";
    await makeShort({ picture: new Uint8Array([7]), script, tts, clip, fontsDir: "/f", out: "/tmp/x.mp4", run: async (a) => { work = a[a.indexOf("-i") + 1]!; } });
    expect(work).toMatch(/short-/);
    expect(existsSync(work)).toBe(false);
  });

  it("fails clearly without a script source, an empty clip, or no audio", async () => {
    const base = { picture: new Uint8Array([7]), tts, clip, fontsDir: "/f", out: "/tmp/x.mp4", run: async () => {} };
    await expect(makeShort(base)).rejects.toThrow(/pass `script`/);
    await expect(makeShort({ ...base, script, clip: async () => new Uint8Array() })).rejects.toThrow(/no video/);
    await expect(makeShort({ ...base, script, tts: async () => ({ audio: new Uint8Array(), words: [], seconds: 0 }) })).rejects.toThrow(/no audio/);
  });

  it("passes on a clip-maker failure (the caller refunds / retries)", async () => {
    await expect(makeShort({ picture: new Uint8Array([7]), script, tts, clip: async () => { throw new Error("comfy: out of credits"); }, fontsDir: "/f", out: "/tmp/x.mp4", run: async () => {} })).rejects.toThrow(/out of credits/);
  });

  it("reports a missing ffmpeg", async () => {
    await expect(makeShort({ picture: new Uint8Array([7]), script, tts, clip, fontsDir: "/f", out: "/tmp/x.mp4", ffmpeg: "/no/such/ffmpeg" })).rejects.toThrow(/not found/);
  });
});
