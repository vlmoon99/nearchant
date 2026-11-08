import { describe, expect, it } from "vitest";
import { askJson, AskError, extractJson, openAiAsk, userMessage, type Ask, type Message } from "../src/openai-ask.js";

const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const noSleep = async () => {};

describe("openAiAsk", () => {
  it("posts to /chat/completions with the model, key and options", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ask = openAiAsk({ baseUrl: "http://x/v1/", model: "m", apiKey: "k", jsonMode: true, extraBody: { top_p: 0.9 }, fetch: async (url, init) => { seen.push({ url: String(url), init: init! }); return ok("hi"); } });
    expect(await ask([{ role: "user", content: "q" }], { temperature: 0.2, maxTokens: 50, json: true })).toBe("hi");
    expect(seen[0]!.url).toBe("http://x/v1/chat/completions");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({ model: "m", temperature: 0.2, max_tokens: 50, top_p: 0.9, response_format: { type: "json_object" } });
  });

  it("retries 5xx and 429 with backoff, then succeeds", async () => {
    const statuses = [500, 429];
    let calls = 0;
    const ask = openAiAsk({ baseUrl: "http://x", model: "m", sleep: noSleep, fetch: async () => { calls++; const s = statuses.shift(); return s ? new Response("busy", { status: s }) : ok("done"); } });
    expect(await ask([{ role: "user", content: "q" }])).toBe("done");
    expect(calls).toBe(3);
  });

  it("does not retry a 400 and gives up after the retries", async () => {
    let calls = 0;
    const bad = openAiAsk({ baseUrl: "http://x", model: "m", sleep: noSleep, fetch: async () => { calls++; return new Response("nope", { status: 400 }); } });
    await expect(bad([{ role: "user", content: "q" }])).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toBe(1);
    calls = 0;
    const down = openAiAsk({ baseUrl: "http://x", model: "m", retries: 2, sleep: noSleep, fetch: async () => { calls++; throw new TypeError("ECONNREFUSED"); } });
    await expect(down([{ role: "user", content: "q" }])).rejects.toBeInstanceOf(AskError);
    expect(calls).toBe(3);
  });

  it("times out and does not retry a timeout", async () => {
    let calls = 0;
    const ask = openAiAsk({ baseUrl: "http://x", model: "m", timeoutMs: 20, sleep: noSleep, fetch: (_u, init) => { calls++; return new Promise((_r, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))); } });
    await expect(ask([{ role: "user", content: "q" }])).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });

  it("joins array content and rejects an answer without content", async () => {
    expect(await openAiAsk({ baseUrl: "http://x", model: "m", fetch: async () => ok([{ type: "text", text: "a" }, { type: "text", text: "b" }]) })([])).toBe("ab");
    await expect(openAiAsk({ baseUrl: "http://x", model: "m", retries: 0, fetch: async () => new Response("{}") })([])).rejects.toThrow(/no message content/);
  });
});

describe("JSON helpers", () => {
  it("turns images into image_url parts", () => {
    expect(userMessage("hi")).toEqual({ role: "user", content: "hi" });
    expect(userMessage({ text: "t", images: ["data:image/png;base64,AA"] }).content).toEqual([{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }]);
  });

  it("extracts JSON from fences, think blocks and chatter", () => {
    expect(extractJson('<think>{"no":1}</think>Sure! ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json")).toThrow();
  });

  it("asks once more with the error when the answer is bad, then gives up", async () => {
    const seen: Message[][] = [];
    const answers = ["not json", '{"n": 2}'];
    const ask: Ask = async (m) => { seen.push([...m]); return answers.shift() ?? "still bad"; };
    const v = (raw: unknown) => { const n = (raw as { n?: unknown }).n; if (typeof n !== "number") throw new Error("n must be a number"); return n; };
    expect(await askJson(ask, { system: "s", user: "u", validate: v })).toBe(2);
    expect(seen[1]!.at(-1)!.content).toMatch(/not a valid answer/);
    await expect(askJson(async () => '{"n":"x"}', { system: "s", user: "u", validate: v })).rejects.toThrow(/n must be a number/);
  });
});
