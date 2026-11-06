import type { AttestationRef, Capability, DataClass, Endpoint, Usage } from "@nearchant/contracts";

export interface CapabilityRequest {
  capability: Capability;
  /** private = seller/buyer data: only endpoints in `private_data_allowed_tiers`. */
  dataClass: DataClass;
  /** Exact model id; otherwise the router picks from config `models[capability]`. */
  model?: string;
  /** Capability input in OpenAI wire shape without `model` (chat: {messages, tools, ...}; embed: {input}; ...). */
  input: Record<string, unknown>;
  /** Restrict to these endpoint ids (still subject to privacy rules). */
  endpoints?: string[];
  /** Per-request timeout (ms); defaults to the endpoint's `timeout_ms`. */
  timeoutMs?: number;
  /** `false`: answer without a thinking phase (short structured roles). A hint, not part of the replay key. */
  reasoning?: boolean;
  signal?: AbortSignal;
}

export interface AdapterResult {
  output: unknown;
  usage: Usage;
  model: string;
  /** NEAR AI chat: the answer's id and the exact request/response bytes, for the response signature check. */
  wire?: { id: string; request: string; response: string };
}

export interface CallContext {
  model: string;
  timeoutMs: number;
  reasoning?: boolean;
  signal?: AbortSignal;
  /** Stable key of the logical request (used by replay). */
  requestKey?: string;
}

/** One model endpoint. New providers are folders in src/adapters implementing this. */
export interface CapabilityAdapter {
  readonly endpoint: Endpoint;
  call(capability: Capability, input: Record<string, unknown>, ctx: CallContext): Promise<AdapterResult>;
  /** Model ids served right now (OpenAI GET /models). */
  listModels(): Promise<string[]>;
  /** Ids plus prices when the endpoint publishes them (NEAR AI does, in `pricing`). */
  catalog?(): Promise<ModelInfo[]>;
  /** TEE attestation for a model; only for endpoints with `attestation` set. `raw` is the report as served. */
  attest?(model: string): Promise<AttestationRef & { raw?: string }>;
  /** NEAR AI's signature of one answer (GET /v1/signature/{id}); null when there is none. */
  responseSignature?(id: string, model: string): Promise<import("./response-signature.js").RawSignature | null>;
}

/** Thrown by adapters; `retryable` errors are retried, then the router moves to the next endpoint. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class NoEndpointError extends Error {
  constructor(
    public readonly capability: Capability,
    public readonly reasons: Record<string, string>,
  ) {
    super(`no endpoint could serve ${capability}: ${JSON.stringify(reasons)}`);
    this.name = "NoEndpointError";
  }
}

export type FetchFn = typeof fetch;

export interface ModelPrice { inputPerMTok?: number; outputPerMTok?: number; perImage?: number; perAudioMinute?: number }
export interface ModelInfo { id: string; price?: ModelPrice }
