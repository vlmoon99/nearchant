import { describe, expect, it } from "vitest";
import { AskError, extractJson, openaiAsk, toDataUrl } from "../src/openai-ask.js";

const reply = (content: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "content-type": "application/json" } });

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("openaiAsk", () => {
  it("sends text + images and parses a fenced JSON answer", async () => {
    const { f, calls } = fakeFetch([reply('<think>hm</think>Sure:\n```json\n{"ok": true}\n```')]);
    const ask = openaiAsk({ baseUrl: "http://x/v1/", model: "m", apiKey: "k", fetch: f, backoffMs: 1 });
    expect(await ask({ system: "s", text: "t", images: [new Uint8Array([0xff, 0xd8, 1])] })).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://x/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    const msgs = calls[0]!.body.messages as { role: string; content: unknown }[];
    expect(msgs[0]).toEqual({ role: "system", content: "s" });
    expect(JSON.stringify(msgs[1]!.content)).toContain("data:image/jpeg;base64,");
  });

  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    const { f, calls } = fakeFetch([new Response("busy", { status: 503 }), new Error("ECONNRESET"), reply('{"a":1}')]);
    expect(await openaiAsk({ baseUrl: "http://x", model: "m", fetch: f, backoffMs: 1 })({ text: "t" })).toEqual({ a: 1 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 401", async () => {
    const { f, calls } = fakeFetch([new Response("bad key", { status: 401 }), reply('{"a":1}')]);
    await expect(openaiAsk({ baseUrl: "http://x", model: "m", fetch: f, backoffMs: 1 })({ text: "t" })).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the retries with the last error", async () => {
    const { f, calls } = fakeFetch([reply("no json here"), reply("still none"), reply("nope")]);
    await expect(openaiAsk({ baseUrl: "http://x", model: "m", fetch: f, backoffMs: 1, retries: 2 })({ text: "t" })).rejects.toBeInstanceOf(AskError);
    expect(calls).toHaveLength(3);
  });

  it("rejects a JSON array (not an object)", async () => {
    const { f } = fakeFetch([reply("[1,2]"), reply("[1,2]")]);
    await expect(openaiAsk({ baseUrl: "http://x", model: "m", fetch: f, backoffMs: 1, retries: 1 })({ text: "t" })).rejects.toThrow();
  });

  it("times out a hanging call", async () => {
    const f = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(openaiAsk({ baseUrl: "http://x", model: "m", fetch: f, timeoutMs: 20, retries: 0 })({ text: "t" })).rejects.toThrow(/model call failed/);
  });
});

describe("helpers", () => {
  it("extractJson finds the object in chatter", () => {
    expect(extractJson('Here you go {"x": [1]} hope it helps')).toEqual({ x: [1] });
    expect(() => extractJson("nothing")).toThrow(AskError);
  });
  it("toDataUrl sniffs PNG", () => {
    expect(toDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toMatch(/^data:image\/png;base64,/);
  });
});
