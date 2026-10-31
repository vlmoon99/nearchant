import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Capability, Endpoint, ResultEnvelope } from "@nearchant/contracts";
import { type AdapterResult, type CallContext, type CapabilityAdapter, ProviderError } from "../types.js";

/**
 * Recorded envelopes on disk, keyed by the router's request key (capability + requested model + input).
 * Used to record real runs and to replay them with no network, no keys and no GPU (ADR 0013).
 */
export class ReplayStore {
  constructor(readonly dir: string) {}

  private file(key: string) {
    return join(this.dir, `${key}.json`);
  }

  get(key: string): ResultEnvelope | undefined {
    const f = this.file(key);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ResultEnvelope) : undefined;
  }

  put(key: string, envelope: ResultEnvelope): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(key), JSON.stringify(envelope, null, 1));
  }
}

/** An endpoint (`adapter: replay`, `base_url: <dir>`) that answers only from recordings. */
export class ReplayAdapter implements CapabilityAdapter {
  private readonly store: ReplayStore;
  constructor(readonly endpoint: Endpoint) {
    this.store = new ReplayStore(endpoint.base_url);
  }

  async call(_capability: Capability, _input: Record<string, unknown>, ctx: CallContext): Promise<AdapterResult> {
    const hit = ctx.requestKey ? this.store.get(ctx.requestKey) : undefined;
    if (!hit) throw new ProviderError(`replay: no recording for request ${ctx.requestKey}`, false, 404);
    return { output: hit.output, usage: hit.usage, model: hit.model };
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}
