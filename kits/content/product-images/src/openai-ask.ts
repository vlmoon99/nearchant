// A small adapter for any OpenAI-compatible chat endpoint (NEAR AI, OpenAI, Ollama, vLLM, LM Studio…): sends text
// and optional images, asks for a JSON object back, and parses it. Timeout, retry with backoff on network errors,
// 429 and 5xx, and one more try when the answer has no readable JSON. The caller still validates the fields.
//
//   const ask = openaiAsk({ baseUrl: "https://api.openai.com/v1", apiKey, model: "gpt-4o-mini" });
//   const raw = await ask({ system: "Answer in JSON.", text: "…", images: [pngBytes] });

/** One question to the model. Images are bytes (sent as data URLs) or `data:`/`https:` URLs. */
export interface AskInput {
  system?: string;
  text: string;
  images?: (Uint8Array | string)[];
  maxTokens?: number;
  temperature?: number;
}
/** What the kits call. It returns the model's JSON answer as `unknown`: always validate before use. */
export type Ask = (input: AskInput) => Promise<unknown>;

export interface OpenAiAskOptions {
  /** e.g. "https://api.openai.com/v1", "http://localhost:11434/v1" (Ollama), "https://cloud-api.near.ai/v1". */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per attempt. Default 60 s. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** First backoff; doubles each retry. Default 1000 ms. */
  backoffMs?: number;
  /** Adds `response_format: {type: "json_object"}` (not every server supports it). Default false. */
  jsonMode?: boolean;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class AskError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); this.name = "AskError"; }
}

/** Pulls the first JSON object out of a model answer (tolerates ``` fences, <think> blocks and chatter). */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AskError("no JSON object in the answer", undefined, true);
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new AskError("the answer's JSON does not parse", undefined, true); }
}

/** Guesses an image type from its first bytes (PNG, JPEG, WEBP, GIF); PNG when unknown. */
export function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  return "image/png";
}
export const toDataUrl = (b: Uint8Array, mime = sniffMime(b)) => `data:${mime};base64,${Buffer.from(b).toString("base64")}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openaiAsk(o: OpenAiAskOptions): Ask {
  const f = o.fetch ?? fetch, timeoutMs = o.timeoutMs ?? 60_000, retries = o.retries ?? 2, backoff = o.backoffMs ?? 1000;
  const url = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}), ...o.headers };

  async function once(input: AskInput): Promise<unknown> {
    const images = (input.images ?? []).map((x) => (typeof x === "string" ? x : toDataUrl(x)));
    const user = images.length ? [{ type: "text", text: input.text }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))] : input.text;
    const body = {
      model: o.model, temperature: input.temperature ?? 0, max_tokens: input.maxTokens ?? 600,
      messages: [...(input.system ? [{ role: "system", content: input.system }] : []), { role: "user", content: user }],
      ...(o.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    let r: Response;
    try {
      r = await f(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AskError(`model call failed: ${(e as Error).message}`, undefined, true);
    }
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      throw new AskError(`model call: HTTP ${r.status} ${detail}`, r.status, r.status === 429 || r.status >= 500);
    }
    const j = (await r.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
    const content = j?.choices?.[0]?.message?.content;
    // Some servers return content as parts: [{type: "text", text}].
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
    if (!text) throw new AskError("the model returned no text", undefined, true);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AskError("the answer is not a JSON object", undefined, true);
    return parsed;
  }

  return async (input) => {
    let last: unknown;
    for (let i = 0; i <= retries; i++) {
      try { return await once(input); } catch (e) {
        last = e;
        if (!(e instanceof AskError && e.retryable) || i === retries) break; // a 400/401 will not get better
        await sleep(backoff * 2 ** i);
      }
    }
    throw last;
  };
}
