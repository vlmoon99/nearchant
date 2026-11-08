// A small adapter for any OpenAI-compatible chat endpoint (NEAR AI Cloud, OpenAI, Ollama, vLLM, llama.cpp, LiteLLM),
// plus the JSON helper every content step uses. No SDK: one fetch per call, with a timeout and retries.
// This file is the same in every content kit; copy it freely.

/** One part of a user message: text, or an image (a data: URL or an https: URL) for vision models. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface AskOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the endpoint for a JSON object (response_format), when the adapter allows it. */
  json?: boolean;
  signal?: AbortSignal;
}

/** The one AI function every content kit needs: messages in, the answer's text out. Bring your own or use openAiAsk. */
export type Ask = (messages: Message[], options?: AskOptions) => Promise<string>;

/** A user turn: plain text, or text with images for vision models. */
export type UserInput = string | { text: string; images: string[] };

export interface OpenAiAskOptions {
  /** e.g. "https://cloud-api.near.ai/v1", "https://api.openai.com/v1", "http://localhost:11434/v1". */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per attempt. Default 120 s (vision and long posts are slow on small GPUs). */
  timeoutMs?: number;
  /** Extra attempts on 429, 5xx and network errors. Default 2. A timeout is not retried: it rarely helps. */
  retries?: number;
  /** Send response_format {type:"json_object"} when a step asks for JSON. Default false: not every server has it,
   *  and the JSON helper below copes with chatty answers anyway. */
  jsonMode?: boolean;
  /** Merged into every request body, e.g. { chat_template_kwargs: { enable_thinking: false } } for Qwen on vLLM. */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class AskError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "AskError";
  }
}

/** Builds an Ask for an OpenAI-compatible /chat/completions endpoint. */
export function openAiAsk(o: OpenAiAskOptions): Ask {
  const url = o.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 2;
  const timeoutMs = o.timeoutMs ?? 120_000;

  return async (messages, opts = {}) => {
    const body: Record<string, unknown> = {
      ...o.extraBody,
      model: o.model,
      messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json && o.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;

    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 200);
      try {
        return await once(doFetch, url, headers, body, timeoutMs, opts.signal);
      } catch (e) {
        last = e;
        if (!(e instanceof AskError) || !e.retryable || opts.signal?.aborted) throw e;
      }
    }
    throw last;
  };
}

async function once(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AskError(`chat request failed: ${(e as Error).message}`, !timeout.aborted);
  }
  const text = await res.text();
  if (!res.ok) throw new AskError(`chat request → ${res.status}: ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500, res.status);
  let raw: { choices?: { message?: { content?: unknown } }[] };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AskError("chat response is not JSON", true, res.status);
  }
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : String((p as { text?: unknown }).text ?? ""))).join("");
  throw new AskError("chat response has no message content", true, res.status);
}

/** Turns a UserInput into a user message (images become image_url parts). */
export function userMessage(user: UserInput): Message {
  if (typeof user === "string" || !user.images.length) return { role: "user", content: typeof user === "string" ? user : user.text };
  return { role: "user", content: [{ type: "text", text: user.text }, ...user.images.map((url): ContentPart => ({ type: "image_url", image_url: { url } }))] };
}

/** Pulls the first JSON object out of an answer (tolerates ``` fences, <think> blocks and chatter around it). */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  return JSON.parse(body.slice(start, end + 1));
}

export interface AskJsonRequest<T> {
  system: string;
  user: UserInput;
  /** Throws (or returns a rejected value) when the parsed JSON is not usable; the message is shown to the model. */
  validate: (raw: unknown) => T;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Asks for JSON, parses and validates it; on a bad answer, tells the model what was wrong and asks once more. */
export async function askJson<T>(ask: Ask, r: AskJsonRequest<T>): Promise<T> {
  const messages: Message[] = [{ role: "system", content: r.system }, userMessage(r.user)];
  const opts: AskOptions = { json: true, ...(r.temperature !== undefined ? { temperature: r.temperature } : {}), ...(r.maxTokens !== undefined ? { maxTokens: r.maxTokens } : {}), ...(r.signal ? { signal: r.signal } : {}) };
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(messages, opts);
    try {
      return r.validate(extractJson(text));
    } catch (e) {
      lastError = (e as Error).message;
      messages.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: `That was not a valid answer (${lastError}). Reply with only the JSON object.` });
    }
  }
  throw new Error(`no valid JSON after a retry: ${lastError}`);
}
