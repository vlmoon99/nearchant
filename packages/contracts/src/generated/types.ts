// GENERATED from spec/schemas by packages/contracts/scripts/gen.mjs — do not edit.

export type Capability =
  | "chat"
  | "vision"
  | "embed"
  | "rerank"
  | "image.generate"
  | "image.edit"
  | "video.generate"
  | "asr"
  | "attest"
  | "decide";

export type PrivacyTier = "tee" | "local" | "public";

export type DataClass = "private" | "public";

export interface Common {
  [k: string]: unknown;
}

export interface ProvidersConfig {
  /**
   * @minItems 1
   */
  endpoints: [Endpoint, ...Endpoint[]];
  routing: Routing;
  /**
   * Preferred model ids per capability, tried in order against each endpoint's live catalog.
   */
  models?: {
    [k: string]: string[];
  };
  /**
   * USD per unit by model id; missing = 0. Units: per 1M input/output tokens, per image.
   */
  prices?: {
    [k: string]: {
      inputPerMTok?: number;
      outputPerMTok?: number;
      perImage?: number;
      perAudioMinute?: number;
    };
  };
}

export interface Endpoint {
  id: string;
  adapter?: "openai-compatible" | "replay";
  base_url: string;
  /**
   * Name of the env var holding the key; the key itself never goes in config.
   */
  api_key_env?: string;
  /**
   * tee = attested confidential compute; local = the operator's own machines; public = anything else.
   */
  privacy_tier: "tee" | "local" | "public";
  attestation?: "nearai" | "none";
  /**
   * @minItems 1
   */
  capabilities: [
    (
      | "chat"
      | "vision"
      | "embed"
      | "rerank"
      | "image.generate"
      | "image.edit"
      | "video.generate"
      | "asr"
      | "attest"
      | "decide"
    ),
    ...(
      | "chat"
      | "vision"
      | "embed"
      | "rerank"
      | "image.generate"
      | "image.edit"
      | "video.generate"
      | "asr"
      | "attest"
      | "decide"
    )[]
  ];
  discover_models?: boolean;
  /**
   * Rename preferred model ids for this endpoint (e.g. a local served-model-name).
   */
  model_map?: {
    [k: string]: string;
  };
  /**
   * If a model fails on this endpoint (outage, failed attestation), try these instead, in order. Each fallback gets its own attestation check; the replay key stays that of the requested model.
   */
  fallback_models?: {
    [k: string]: string[];
  };
  timeout_ms?: number;
  /**
   * Merged into every request body (e.g. chat_template_kwargs).
   */
  extra_body?: {};
}

export interface Routing {
  /**
   * Items: tee = attested confidential compute; local = the operator's own machines; public = anything else.
   */
  private_data_allowed_tiers: ("tee" | "local" | "public")[];
  /**
   * capability → endpoint ids in priority order
   */
  [k: string]: string[] | ("tee" | "local" | "public")[];
}

export interface ResultEnvelope {
  capability:
    | "chat"
    | "vision"
    | "embed"
    | "rerank"
    | "image.generate"
    | "image.edit"
    | "video.generate"
    | "asr"
    | "attest"
    | "decide";
  /**
   * Capability-specific output (chat message, vectors, image refs, transcript).
   */
  output: unknown;
  model: string;
  endpointId: string;
  /**
   * tee = attested confidential compute; local = the operator's own machines; public = anything else.
   */
  privacyTier: "tee" | "local" | "public";
  usage: Usage;
  /**
   * 0 for local endpoints.
   */
  costUsd: number;
  attestation?: AttestationRef;
  requestHash: string;
  outputHash: string;
  latencyMs: number;
  createdAt: string;
  /**
   * True when served by the replay provider.
   */
  replayed?: boolean;
  responseSignature?: ResponseSignature;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  videoSeconds?: number;
  audioSeconds?: number;
}

export interface AttestationRef {
  kind: "nearai" | "dstack";
  /**
   * sha256 of the raw attestation report.
   */
  reportHash: string;
  signingAddress?: string;
  nonce?: string;
  fetchedAt: string;
  /**
   * False in M0: the report is fetched and pinned, not cryptographically verified.
   */
  verified?: boolean;
  /**
   * ed25519 keys of the model TEEs named in the report (their REPORTDATA binds them).
   */
  modelSigners?: string[];
}

export interface ResponseSignature {
  kind: "provider_tee" | "gateway" | "none";
  signingAlgo?: string;
  signingAddress?: string;
  text?: string;
  signature?: string;
  /**
   * Signature valid, text = our own hashes of the exact bytes, signer = a key from the pinned attestation report.
   */
  verified: boolean;
  error?: string;
}

export interface UsageRecord {
  recordId: string;
  /**
   * NEAR account billed.
   */
  accountId: string;
  capability:
    | "chat"
    | "vision"
    | "embed"
    | "rerank"
    | "image.generate"
    | "image.edit"
    | "video.generate"
    | "asr"
    | "attest"
    | "decide";
  endpointId: string;
  model: string;
  usage: Usage;
  costUsd: number;
  /**
   * Charge in token base units (U128 string, nUSD 6 decimals).
   */
  chargeUnits: string;
  requestHash: string;
  createdAt: string;
  /**
   * Gateway signature over the canonical record without this field.
   */
  signature?: string;
}
