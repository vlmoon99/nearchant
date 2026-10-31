import { validate, type AttestationRef, type Capability, type Endpoint, type ProvidersConfig, type ResultEnvelope, type Usage } from "@nearchant/contracts";
import { OpenAICompatibleAdapter } from "./adapters/openai-compatible.js";
import { ReplayAdapter, ReplayStore } from "./adapters/replay.js";
import { hashOf } from "./hash.js";
import { type CapabilityAdapter, type CapabilityRequest, type FetchFn, NoEndpointError, ProviderError } from "./types.js";

export interface RouterOptions {
  /** Where `api_key_env` names are looked up. */
  env?: Record<string, string | undefined>;
  fetch?: FetchFn;
  log?: (level: "info" | "warn", msg: string) => void;
  /** Save every successful live envelope here (to build replay fixtures). */
  record?: ReplayStore;
  /** Extra attempts per endpoint on retryable errors. */
  retries?: number;
  breaker?: { failures: number; cooldownMs: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface EndpointState {
  adapter: CapabilityAdapter;
  catalog?: Set<string>;
  failures: number;
  openUntil: number;
}

const ATTEST_TTL_MS = 10 * 60_000;

/**
 * Routes every capability call to an endpoint by config: priority order, privacy tier, live model catalog,
 * retries with backoff, a circuit breaker, TEE attestation, cost. Returns the normalized ResultEnvelope.
 */
export class Router {
  private readonly state = new Map<string, EndpointState>();
  private readonly attestations = new Map<string, AttestationRef & { at: number }>();
  private readonly opts: Required<Pick<RouterOptions, "retries" | "breaker" | "now" | "sleep" | "log">> & RouterOptions;

  static fromConfig(config: unknown, opts: RouterOptions = {}): Router {
    const c = validate<ProvidersConfig>("providers-config.schema.json", structuredClone(config));
    const env = opts.env ?? process.env;
    const adapters = c.endpoints.map((e): CapabilityAdapter => {
      if (e.adapter === "replay") return new ReplayAdapter(e);
      return new OpenAICompatibleAdapter(e, e.api_key_env ? env[e.api_key_env] : undefined, opts.fetch ?? fetch);
    });
    return new Router(c, adapters, opts);
  }

  constructor(
    readonly config: ProvidersConfig,
    adapters: CapabilityAdapter[],
    opts: RouterOptions = {},
  ) {
    for (const a of adapters) this.state.set(a.endpoint.id, { adapter: a, failures: 0, openUntil: 0 });
    this.opts = {
      retries: 1,
      breaker: { failures: 3, cooldownMs: 30_000 },
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (level, msg) => (level === "warn" ? console.warn : console.info)(`[router] ${msg}`),
      ...opts,
    };
    for (const [cap, ids] of Object.entries(this.routes())) {
      for (const id of ids) if (!this.state.has(id)) throw new Error(`routing.${cap} names unknown endpoint ${id}`);
    }
  }

  private routes(): Record<string, string[]> {
    const { private_data_allowed_tiers: _, ...r } = this.config.routing;
    return r as Record<string, string[]>;
  }

  /** Startup validation: fetch each endpoint's model list. Never throws; a dead endpoint is logged and skipped later. */
  async discover(): Promise<Record<string, string[] | { error: string }>> {
    const out: Record<string, string[] | { error: string }> = {};
    await Promise.all(
      [...this.state.entries()].map(async ([id, s]) => {
        if (s.adapter.endpoint.discover_models === false || s.adapter.endpoint.adapter === "replay") return;
        try {
          const models = await s.adapter.listModels();
          s.catalog = new Set(models);
          out[id] = models;
        } catch (e) {
          out[id] = { error: (e as Error).message };
          this.opts.log("warn", `discover ${id}: ${(e as Error).message}`);
        }
      }),
    );
    for (const [cap, wanted] of Object.entries(this.config.models ?? {})) {
      for (const id of this.routes()[cap] ?? []) {
        const s = this.state.get(id)!;
        if (!s.catalog) continue;
        const ep = s.adapter.endpoint;
        if (!wanted.some((m) => s.catalog!.has(ep.model_map?.[m] ?? m))) {
          this.opts.log("warn", `${id} serves none of the preferred ${cap} models (${wanted.join(", ")})`);
        }
      }
    }
    return out;
  }

  /** Endpoint health for /health and `make doctor`. */
  health() {
    const now = this.opts.now();
    return Object.fromEntries(
      [...this.state.entries()].map(([id, s]) => [id, { open: s.openUntil > now, failures: s.failures, models: s.catalog?.size ?? null }]),
    );
  }

  async call(req: CapabilityRequest): Promise<ResultEnvelope> {
    const requestKey = hashOf({ capability: req.capability, model: req.model ?? null, input: req.input });
    const reasons: Record<string, string> = {};
    const ids = (this.routes()[req.capability] ?? []).filter((id) => !req.endpoints || req.endpoints.includes(id));
    if (ids.length === 0) throw new NoEndpointError(req.capability, { routing: `no route for ${req.capability}` });

    for (const id of ids) {
      const s = this.state.get(id)!;
      const ep = s.adapter.endpoint;
      const skip = this.skipReason(ep, s, req);
      if (skip) {
        reasons[id] = skip;
        continue;
      }
      const model = this.pickModel(ep, s, req);
      if (!model && ep.adapter !== "replay") {
        reasons[id] = "no preferred model served";
        continue;
      }
      try {
        return await this.callEndpoint(s, req, model ?? req.model ?? "", requestKey);
      } catch (e) {
        if (req.signal?.aborted) throw e;
        reasons[id] = (e as Error).message;
        this.opts.log("warn", `${req.capability} via ${id} failed: ${(e as Error).message}`);
      }
    }
    throw new NoEndpointError(req.capability, reasons);
  }

  private skipReason(ep: Endpoint, s: EndpointState, req: CapabilityRequest): string | undefined {
    if (!ep.capabilities.includes(req.capability)) return `does not offer ${req.capability}`;
    if (req.dataClass === "private" && !this.config.routing.private_data_allowed_tiers.includes(ep.privacy_tier)) {
      return `privacy: ${ep.privacy_tier} tier not allowed for private data`;
    }
    if (s.openUntil > this.opts.now()) return "circuit open";
    return undefined;
  }

  private pickModel(ep: Endpoint, s: EndpointState, req: CapabilityRequest): string | undefined {
    const wanted = req.model ? [req.model] : (this.config.models?.[req.capability] ?? []);
    const mapped = wanted.map((m) => ep.model_map?.[m] ?? m);
    if (!s.catalog) return mapped[0];
    const hit = mapped.find((m) => s.catalog!.has(m));
    if (hit) return hit;
    if (!req.model && mapped.length === 0) return [...s.catalog][0];
    return undefined;
  }

  private async callEndpoint(s: EndpointState, req: CapabilityRequest, model: string, requestKey: string): Promise<ResultEnvelope> {
    const ep = s.adapter.endpoint;
    const attestation = await this.attestation(s, model, req.dataClass === "private");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) await this.opts.sleep(300 * 2 ** (attempt - 1) + Math.random() * 100);
      const started = this.opts.now();
      try {
        const r = await s.adapter.call(req.capability, req.input, { model, timeoutMs: ep.timeout_ms ?? 120_000, signal: req.signal, requestKey });
        s.failures = 0;
        const replayed = ep.adapter === "replay";
        const env: ResultEnvelope = {
          capability: req.capability,
          output: r.output,
          model: r.model,
          endpointId: ep.id,
          privacyTier: ep.privacy_tier,
          usage: r.usage,
          costUsd: replayed || ep.privacy_tier === "local" ? 0 : this.cost(r.model, r.usage),
          ...(attestation ? { attestation: stripAt(attestation) } : {}),
          requestHash: requestKey,
          outputHash: hashOf(r.output),
          latencyMs: Math.max(0, Math.round(this.opts.now() - started)),
          createdAt: new Date().toISOString(),
          ...(replayed ? { replayed: true } : {}),
        };
        if (!replayed) this.opts.record?.put(requestKey, env);
        return env;
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof ProviderError && e.retryable;
        if (!retryable || req.signal?.aborted) break;
      }
    }
    this.fail(s);
    throw lastErr;
  }

  private fail(s: EndpointState) {
    s.failures += 1;
    if (s.failures >= this.opts.breaker.failures) {
      s.openUntil = this.opts.now() + this.opts.breaker.cooldownMs;
      s.failures = 0;
      this.opts.log("warn", `circuit opened for ${s.adapter.endpoint.id} (${this.opts.breaker.cooldownMs} ms)`);
    }
  }

  /** TEE endpoints: fetch (and cache) the attestation report before private data goes out. */
  private async attestation(s: EndpointState, model: string, required: boolean): Promise<(AttestationRef & { at: number }) | undefined> {
    const ep = s.adapter.endpoint;
    if (ep.attestation !== "nearai" || !s.adapter.attest) return undefined;
    const key = `${ep.id}:${model}`;
    const cached = this.attestations.get(key);
    if (cached && this.opts.now() - cached.at < ATTEST_TTL_MS) return cached;
    try {
      const a = { ...(await s.adapter.attest(model)), at: this.opts.now() };
      this.attestations.set(key, a);
      return a;
    } catch (e) {
      if (required) {
        this.fail(s);
        throw new ProviderError(`attestation failed, private data not sent: ${(e as Error).message}`, false);
      }
      return undefined;
    }
  }

  private cost(model: string, u: Usage): number {
    const p = this.config.prices?.[model];
    if (!p) return 0;
    const c =
      ((u.inputTokens ?? 0) * (p.inputPerMTok ?? 0) + (u.outputTokens ?? 0) * (p.outputPerMTok ?? 0)) / 1e6 +
      (u.images ?? 0) * (p.perImage ?? 0) +
      ((u.audioSeconds ?? 0) / 60) * (p.perAudioMinute ?? 0);
    return Math.round(c * 1e8) / 1e8;
  }
}

function stripAt(a: AttestationRef & { at: number }): AttestationRef {
  const { at: _, ...rest } = a;
  return rest;
}
