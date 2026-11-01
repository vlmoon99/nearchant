import { describe, expect, it } from "vitest";
import { makeTts } from "../src/tts.js";

function fake(script: ((url: string, init?: RequestInit) => Response | Promise<Response>)[]) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${url}`); const next = script.shift(); if (!next) throw new Error("no more"); return next(url, init); }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("makeTts", () => {
  it("generates, then fetches the wav and the word timings", async () => {
    const { f, calls } = fake([
      () => json({ audio: { path: "h1/vo.wav", duration_s: 9.5 } }),
      (u) => u.endsWith("/files/h1/vo.wav") ? new Response(new Uint8Array([1, 2, 3])) : json({ words: [{ word: "Hi", start: 0, end: 0.4 }] }),
      (u) => u.endsWith("/files/h1/vo.wav") ? new Response(new Uint8Array([1, 2, 3])) : json({ words: [{ word: "Hi", start: 0, end: 0.4 }] }),
    ]);
    const r = await makeTts("http://tts:8105", "k", f).speak("Hi", "h1");
    expect(r.wav).toHaveLength(3);
    expect(r.words[0]!.word).toBe("Hi");
    expect(r.seconds).toBe(9.5);
    expect(calls[0]).toBe("POST http://tts:8105/generate");
  });
  it("retries a 502 and gives up on a 4xx", async () => {
    const { f, calls } = fake([() => json({}, 502), () => json({ detail: "bad" }, 422)]);
    await expect(makeTts("http://tts", "", f, 3).speak("x", "h")).rejects.toThrow(/422/);
    expect(calls).toHaveLength(2);
  });
});
