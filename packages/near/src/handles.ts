import type { Viewer } from "./chain.js";

export interface Card {
  name: string;
  bio: string;
  avatar_hash: string | null;
  links: string[];
}

export interface HandleRecord {
  handle: string;
  owner_id: string;
  account_id: string;
  payout_account_id: string;
  payout_token_id: string | null;
  card: Card;
  gateway_url: string | null;
  embed_origins: string[];
  status: "Active" | "Pending" | "Suspended";
  created_at: string;
  card_published_at: string | null;
}

/** Same rule as the `handles` contract: 2–32 of a-z 0-9 - _, alnum at both ends, no doubled separators. */
export function validHandle(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){0,30}[a-z0-9]$/.test(name);
}

/**
 * Handle lookups for the gateway (ADR 0008). The `handles` contract is the source of truth; this cache keeps
 * records for `ttlMs` (misses for `missTtlMs`) and never serves a record past `maxStaleMs`. The Host header is
 * only a lookup key.
 */
export class HandleCache {
  private readonly hits = new Map<string, { at: number; record: HandleRecord | null }>();
  private readonly inflight = new Map<string, Promise<HandleRecord | null>>();

  constructor(
    private readonly view: Viewer,
    private readonly factoryId: string,
    private readonly opts: { ttlMs?: number; missTtlMs?: number; maxStaleMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async get(handle: string): Promise<HandleRecord | null> {
    if (!validHandle(handle)) return null;
    const c = this.hits.get(handle);
    const age = c ? this.now() - c.at : Infinity;
    const ttl = c?.record ? (this.opts.ttlMs ?? 60_000) : (this.opts.missTtlMs ?? 10_000);
    if (c && age < ttl) return c.record;
    try {
      return await this.load(handle);
    } catch (e) {
      // RPC down: serve a recent record (offline fallback), but never one older than maxStaleMs.
      if (c?.record && age < (this.opts.maxStaleMs ?? 24 * 3_600_000)) return c.record;
      throw e;
    }
  }

  /** Drop a cached record (e.g. after the dashboard updated it). */
  invalidate(handle: string) {
    this.hits.delete(handle);
  }

  private load(handle: string): Promise<HandleRecord | null> {
    let p = this.inflight.get(handle);
    if (!p) {
      p = this.view<HandleRecord | null>(this.factoryId, "get_handle", { handle })
        .then((record) => {
          this.hits.set(handle, { at: this.now(), record: record ?? null });
          return record ?? null;
        })
        .finally(() => this.inflight.delete(handle));
      this.inflight.set(handle, p);
    }
    return p;
  }
}

/** First DNS label of the host if it is under one of `baseDomains` (one level only, ADR 0008). */
export function handleFromHost(host: string | undefined, baseDomains: string[]): string | null {
  if (!host) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  for (const base of baseDomains) {
    const suffix = "." + base.toLowerCase();
    if (h.endsWith(suffix)) {
      const label = h.slice(0, -suffix.length);
      return label.includes(".") ? null : label;
    }
  }
  return null;
}
