// The one RPC call the server needs: view_access_key. Timeout per request, retry with backoff on network errors,
// 5xx and RPC timeouts; a fetch you can swap in tests.
export type Network = "testnet" | "mainnet";
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const DEFAULT_RPC: Record<Network, string> = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" };

export interface RpcOptions { network?: Network; rpcUrl?: string; timeoutMs?: number; retries?: number; fetch?: FetchLike }

export class RpcUnavailable extends Error { constructor(m: string) { super(m); this.name = "RpcUnavailable"; } }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "FullAccess", "FunctionCall", or null when the account doesn't have this key (or doesn't exist). */
export async function accessKeyPermission(accountId: string, publicKey: string, o: RpcOptions = {}): Promise<"FullAccess" | "FunctionCall" | null> {
  const f: FetchLike = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const url = o.rpcUrl ?? DEFAULT_RPC[o.network ?? "testnet"];
  const body = JSON.stringify({ jsonrpc: "2.0", id: "login", method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey } });
  const retries = o.retries ?? 2;
  for (let i = 0; ; i++) {
    let why: string;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
    try {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctl.signal });
      if (res.status >= 500 || res.status === 429) why = `HTTP ${res.status}`;
      else {
        const j = (await res.json()) as { result?: { permission?: unknown; error?: string }; error?: { cause?: { name?: string }; message?: string } };
        const name = j.error?.cause?.name ?? "";
        if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(name) || /does not exist|access key .* does not exist/i.test(j.result?.error ?? "")) return null;
        if (j.error && name !== "TIMEOUT_ERROR" && name !== "INTERNAL_ERROR") throw new RpcUnavailable(`RPC error: ${name || j.error.message}`);
        if (j.result?.permission === "FullAccess") return "FullAccess";
        if (j.result?.permission && typeof j.result.permission === "object") return "FunctionCall";
        why = name || "RPC sent no permission";
      }
    } catch (e) {
      if (e instanceof RpcUnavailable) throw e;
      why = (e as Error).message;
    } finally {
      clearTimeout(t);
    }
    if (i >= retries) throw new RpcUnavailable(`NEAR RPC unavailable: ${why}`);
    await sleep(300 * 2 ** i);
  }
}
