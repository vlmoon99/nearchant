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
  signal?: AbortSignal;
}

export interface AdapterResult {
  output: unknown;
  usage: Usage;
  model: string;
}

export interface CallContext {
  model: string;
  timeoutMs: number;
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
  /** TEE attestation for a model; only for endpoints with `attestation` set. */
  attest?(model: string): Promise<AttestationRef>;
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
