// A tiny NEAR JSON-RPC client for views: timeout per request, retry with backoff, and a fetch you can swap in tests.
// Views use finality "optimistic" by default: "final" lags ~2 blocks, so a balance read right after a faucet
// transfer still showed 0 in Nearchant until we switched (real bug, Nov 2026).

export type Network = "testnet" | "mainnet";
export type Finality = "optimistic" | "final";
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const DEFAULT_RPC: Record<Network, string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

export interface RpcOptions {
  /** Full RPC URL; default: a public RPC for `network`. */
  rpcUrl?: string;
  network?: Network;
  /** Per request, ms. Default 8000. */
  timeoutMs?: number;
  /** Extra attempts after the first on network errors / 5xx / 429. Default 2. */
  retries?: number;
  finality?: Finality;
  fetch?: FetchLike;
}

export class RpcError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "RpcError";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rpcUrlOf = (o: RpcOptions) => o.rpcUrl ?? DEFAULT_RPC[o.network ?? "testnet"];

/** Runs `fn` until it succeeds, retrying only errors marked retryable, with 300 ms · 2^n backoff. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseMs = 300): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof RpcError ? e.retryable : true;
      if (!retryable || i >= retries) throw e;
      await sleep(baseMs * 2 ** i);
    }
  }
}

/** One JSON-RPC call (`method`, `params`) with timeout + retry. Returns `result` or throws RpcError. */
export async function rpc<T>(method: string, params: unknown, o: RpcOptions = {}): Promise<T> {
  const f: FetchLike = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const url = rpcUrlOf(o);
  return withRetry(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kit", method, params }), signal: ctl.signal });
    } catch (e) {
      throw new RpcError(`NEAR RPC unreachable: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) throw new RpcError(`NEAR RPC HTTP ${res.status}`, true);
    const j = (await res.json().catch(() => null)) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string; data?: unknown } } | null;
    if (!j) throw new RpcError("NEAR RPC sent no JSON", true);
    if (j.error) {
      const name = j.error.cause?.name ?? "";
      throw new RpcError(`${name || j.error.message || "RPC error"}: ${JSON.stringify(j.error.data ?? "")}`, name === "TIMEOUT_ERROR" || name === "INTERNAL_ERROR");
    }
    // Old RPCs report view errors inside result.error.
    if (j.result && typeof j.result === "object" && "error" in j.result && j.result.error) throw new RpcError(String(j.result.error), false);
    return j.result as T;
  }, o.retries ?? 2);
}

const toB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromBytes = (b: number[]) => new TextDecoder().decode(new Uint8Array(b));

/** Calls a contract view method and parses its JSON result. */
export async function viewCall<T>(contract: string, method: string, args: Record<string, unknown>, o: RpcOptions = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function", finality: o.finality ?? "optimistic", account_id: contract, method_name: method, args_base64: toB64(JSON.stringify(args)),
  }, o);
  return JSON.parse(fromBytes(r.result)) as T;
}

/** True when the account exists on chain. */
export async function accountExists(accountId: string, o: RpcOptions = {}): Promise<boolean> {
  try {
    await rpc("query", { request_type: "view_account", finality: o.finality ?? "optimistic", account_id: accountId }, o);
    return true;
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return false;
    throw e;
  }
}
