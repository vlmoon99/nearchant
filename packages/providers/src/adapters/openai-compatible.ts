import type { AttestationRef, Capability, Endpoint } from "@nearchant/contracts";
import { sha256 } from "../hash.js";
import { type AdapterResult, type CallContext, type CapabilityAdapter, type FetchFn, type ModelInfo, ProviderError } from "../types.js";

const PATHS: Partial<Record<Capability, string>> = {
  chat: "/chat/completions",
  vision: "/chat/completions",
  embed: "/embeddings",
  rerank: "/rerank",
  "image.generate": "/images/generations",
  "image.edit": "/images/edits",
  asr: "/audio/transcriptions",
};

/** NEAR AI Cloud, vLLM, llama.cpp, Ollama, TEI and LiteLLM all speak this. */
export class OpenAICompatibleAdapter implements CapabilityAdapter {
  constructor(
    readonly endpoint: Endpoint,
    private readonly apiKey: string | undefined,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["content-type"] = "application/json";
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private url(path: string) {
    return this.endpoint.base_url.replace(/\/+$/, "") + path;
  }

  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), { ...init, signal: s });
    } catch (e) {
      if (signal?.aborted) throw e;
      // A timed-out generation rarely finishes on an immediate retry: fail fast so the caller can fall back.
      const timedOut = timeout.aborted;
      throw new ProviderError(`${this.endpoint.id}: ${(e as Error).message}`, !timedOut);
    }
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${this.endpoint.id} ${path} → ${res.status}: ${text.slice(0, 300)}`, retryable, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`${this.endpoint.id} ${path}: response is not JSON`, true, res.status);
    }
  }

  async call(capability: Capability, input: Record<string, unknown>, ctx: CallContext): Promise<AdapterResult> {
    const path = PATHS[capability];
    if (!path) throw new ProviderError(`${this.endpoint.id}: ${capability} not supported by this adapter`, false);
    if (capability === "asr") return this.transcribe(input, ctx);
    const body: Record<string, unknown> = { ...(this.endpoint.extra_body ?? {}), ...input, model: ctx.model };
    // vLLM / SGLang chat templates (Qwen3, GLM) switch the thinking phase with this flag.
    if (ctx.reasoning === false && (capability === "chat" || capability === "vision")) {
      body.chat_template_kwargs = { ...((body.chat_template_kwargs as object) ?? {}), enable_thinking: false };
    }
    if (capability === "image.generate" || capability === "image.edit") {
      body.response_format ??= "b64_json";
    }
    const raw = (await this.request(path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, ctx.timeoutMs, ctx.signal)) as Record<string, any>;
    const u = raw.usage ?? {};
    switch (capability) {
      case "chat":
      case "vision": {
        const choice = raw.choices?.[0];
        if (!choice?.message) throw new ProviderError(`${this.endpoint.id}: no choices in chat response`, true);
        return {
          model: raw.model ?? ctx.model,
          output: { message: choice.message, finish_reason: choice.finish_reason ?? null },
          usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
        };
      }
      case "embed":
        return {
          model: raw.model ?? ctx.model,
          output: { vectors: (raw.data ?? []).map((d: { embedding: number[] }) => d.embedding), dim: raw.data?.[0]?.embedding?.length ?? 0 },
          usage: { inputTokens: u.prompt_tokens ?? u.total_tokens ?? 0 },
        };
      case "rerank":
        return { model: raw.model ?? ctx.model, output: { results: raw.results ?? raw.data ?? [] }, usage: { inputTokens: u.total_tokens ?? 0 } };
      default: {
        const images = (raw.data ?? []).map((d: { b64_json?: string; url?: string }) => ({ b64: d.b64_json, url: d.url }));
        return { model: raw.model ?? ctx.model, output: { images }, usage: { images: images.length } };
      }
    }
  }

  private async transcribe(input: Record<string, unknown>, ctx: CallContext): Promise<AdapterResult> {
    const audio = input.audio as Uint8Array | undefined;
    if (!audio) throw new ProviderError("asr needs input.audio bytes", false);
    const form = new FormData();
    form.set("file", new Blob([audio as Uint8Array<ArrayBuffer>]), String(input.filename ?? "audio.ogg"));
    form.set("model", ctx.model);
    if (input.language) form.set("language", String(input.language));
    const raw = (await this.request("/audio/transcriptions", { method: "POST", headers: this.headers(false), body: form }, ctx.timeoutMs, ctx.signal)) as Record<string, any>;
    return { model: ctx.model, output: { text: raw.text ?? "" }, usage: { audioSeconds: Number(raw.duration ?? 0) } };
  }

  async listModels(): Promise<string[]> {
    return (await this.catalog()).map((m) => m.id);
  }

  async catalog(): Promise<ModelInfo[]> {
    const raw = (await this.request("/models", { headers: this.headers() }, 15_000)) as { data?: { id: string; pricing?: Record<string, string | number> }[] };
    return (raw.data ?? []).map((m) => {
      const p = m.pricing;
      if (!p) return { id: m.id };
      // `prompt` / `completion` are USD per token, `image` USD per image (OpenRouter-style, used by NEAR AI).
      const perTok = (v: unknown) => (v === undefined ? undefined : Number(v) * 1e6);
      return { id: m.id, price: { inputPerMTok: perTok(p.prompt), outputPerMTok: perTok(p.completion), perImage: p.image === undefined ? undefined : Number(p.image) } };
    });
  }

  /** NEAR AI: GET /attestation/report?model=&nonce=. M0 pins the report hash; it does not verify the quote. */
  async attest(model: string): Promise<AttestationRef & { raw: string }> {
    if (this.endpoint.attestation !== "nearai") throw new ProviderError(`${this.endpoint.id}: no attestation`, false);
    const nonce = sha256(crypto.getRandomValues(new Uint8Array(32)));
    const path = `/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}`;
    const timeout = AbortSignal.timeout(20_000);
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), { headers: this.headers(), signal: timeout });
    } catch (e) {
      throw new ProviderError(`${this.endpoint.id} attestation: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`${this.endpoint.id} attestation → ${res.status}`, res.status >= 500, res.status);
    let signingAddress: string | undefined;
    try {
      const j = JSON.parse(text);
      signingAddress = j?.gateway_attestation?.signing_address ?? j?.signing_address;
    } catch {
      /* keep the hash of whatever came back */
    }
    return { kind: "nearai", reportHash: sha256(text), ...(signingAddress ? { signingAddress } : {}), nonce, fetchedAt: new Date().toISOString(), verified: false, raw: text };
  }
}
