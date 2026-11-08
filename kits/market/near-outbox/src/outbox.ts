// Transactional outbox: record the side effect first (idempotent by key), send it from a worker that retries with
// backoff, and let the UI read its state. Delivery is at-least-once, so a handler must itself be idempotent: check
// the chain (or the receiver) before sending again — a crash after the send but before `finish` repeats the call.
import { exponentialBackoff } from "./backoff.js";
import type { ActionStatus, OutboxItem, OutboxStore } from "./types.js";

export interface HandlerContext {
  key: string;
  /** 1 on the first try. */
  attempt: number;
  /** Aborted on worker stop or handler timeout: pass it to fetch / RPC calls. */
  signal: AbortSignal;
}
export type Handler = (payload: any, ctx: HandlerContext) => Promise<unknown>;
export type Handlers = Record<string, Handler>;

export interface DrainOptions {
  handlers: Handlers;
  /** After this many failed tries the item is `failed` (no more retries). Default 8. */
  maxAttempts?: number;
  /** Delay after `attempt` failed tries. Default exponentialBackoff() (2 s doubling to 10 min, ±20 %). */
  backoff?: (attempt: number) => number;
  /** Each handler call is aborted after this long. Default 120 s. */
  timeoutMs?: number;
  /** Most items to process in one drain. Default 20. */
  limit?: number;
  signal?: AbortSignal;
  /** Called with a short line for each try (log it or ignore it). */
  log?: (line: string) => void;
}
export interface WorkerOptions extends DrainOptions {
  /** Wait between empty polls. Default 1 s. */
  pollMs?: number;
}
export interface DrainResult { sent: number; retrying: number; failed: number }

export interface OutboxOptions {
  /** Clock in ms (for tests). Default Date.now. */
  now?: () => number;
  /** A `sending` item untouched this long is claimed again (its worker died). Default 5 min; keep it above timeoutMs. */
  staleMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/** Runs `fn` with a signal that aborts on `parent` abort or after `ms`; rejects on timeout even if fn ignores it. */
async function withTimeout<T>(ms: number, parent: AbortSignal | undefined, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onParent = () => ac.abort(parent?.reason ?? new Error("worker stopped"));
  parent?.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { const e = new Error(`timed out after ${ms} ms`); ac.abort(e); reject(e); }, ms); });
  try { return await Promise.race([fn(ac.signal), timeout]); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", onParent); }
}

export const toStatus = (r: OutboxItem): ActionStatus => ({
  key: r.key, kind: r.kind, state: r.state, attempts: r.attempts, error: r.lastError,
  since: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

export class Outbox {
  private readonly now: () => number;
  private readonly staleMs: number;
  constructor(readonly store: OutboxStore, opts: OutboxOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 5 * 60_000;
  }

  /** Queues a side effect once per key. True if it was new; false if the key was already queued (any state). */
  enqueue(key: string, kind: string, payload: unknown): Promise<boolean> {
    if (!key) throw new Error("outbox key is empty");
    return this.store.insert(key, kind, payload, new Date(this.now()));
  }

  get(key: string): Promise<OutboxItem | null> { return this.store.get(key); }

  /** The newest item for an action that can repeat: `base` itself or a later `base:<n>`. */
  latest(base: string): Promise<OutboxItem | null> { return this.store.latest(base); }

  /**
   * Queues an action that may happen again (ship again after a revision, retry after `failed`): the first one is
   * `base`, later ones `base:<ms>`. A no-op (false) while the last one is still pending or sending.
   */
  async enqueueAgain(base: string, kind: string, payload: unknown): Promise<boolean> {
    const last = await this.latest(base);
    if (last && (last.state === "pending" || last.state === "sending")) return false;
    if (!last) return this.enqueue(base, kind, payload);
    // Same millisecond twice: step forward until the key is free.
    for (let t = this.now(), i = 0; i < 1000; i++, t++) if (await this.enqueue(`${base}:${t}`, kind, payload)) return true;
    return false;
  }

  /** State of the newest item for `base`, shaped for a UI. Null if never queued. */
  async status(base: string): Promise<ActionStatus | null> {
    const r = await this.latest(base);
    return r ? toStatus(r) : null;
  }

  /**
   * The open (not done) action among several bases, newest first — e.g. an order's ship / refund / decline.
   * Null when there is none, which a UI reads as "nothing on its way".
   */
  async current(bases: string[]): Promise<ActionStatus | null> {
    const rows = (await Promise.all(bases.map((b) => this.latest(b)))).filter((r): r is OutboxItem => r !== null);
    const last = rows.sort((a, b) => b.id - a.id)[0];
    return last && last.state !== "done" ? toStatus(last) : null;
  }

  /** Processes due items until none is due (or `limit`). Safe to run from many workers at once. */
  async drain(o: DrainOptions): Promise<DrainResult> {
    const maxAttempts = o.maxAttempts ?? 8, backoff = o.backoff ?? exponentialBackoff(), timeoutMs = o.timeoutMs ?? 120_000;
    const out: DrainResult = { sent: 0, retrying: 0, failed: 0 };
    for (let i = 0; i < (o.limit ?? 20) && !o.signal?.aborted; i++) {
      const now = this.now();
      const item = await this.store.claim(new Date(now), new Date(now - this.staleMs));
      if (!item) break;
      const handler = Object.hasOwn(o.handlers, item.kind) ? o.handlers[item.kind] : undefined;
      try {
        if (!handler) throw new Error(`no handler for outbox kind "${item.kind}"`);
        const result = await withTimeout(timeoutMs, o.signal, (signal) => handler(item.payload, { key: item.key, attempt: item.attempts, signal }));
        await this.store.finish(item.id, { state: "done", lastError: null, result: result ?? null, nextAt: new Date(this.now()) }, new Date(this.now()));
        out.sent++;
        o.log?.(`outbox ${item.key}: done (try ${item.attempts})`);
      } catch (e) {
        const dead = item.attempts >= maxAttempts;
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 2000) || "error";
        const at = this.now();
        await this.store.finish(item.id, { state: dead ? "failed" : "pending", lastError: error, nextAt: new Date(at + (dead ? 0 : backoff(item.attempts))) }, new Date(at));
        if (dead) out.failed++; else out.retrying++;
        o.log?.(`outbox ${item.key}: ${dead ? "failed" : "will retry"} after try ${item.attempts}: ${error}`);
      }
    }
    return out;
  }

  /** Drains forever (until `signal` aborts), sleeping `pollMs` when nothing is due. Store errors are logged, not fatal. */
  async runWorker(o: WorkerOptions): Promise<void> {
    const pollMs = o.pollMs ?? 1_000;
    while (!o.signal?.aborted) {
      let busy = false;
      try {
        const r = await this.drain(o);
        busy = r.sent + r.retrying + r.failed >= (o.limit ?? 20);
      } catch (e) {
        o.log?.(`outbox worker: ${(e as Error).message}`);
      }
      if (!busy) await sleep(pollMs, o.signal);
    }
  }
}
