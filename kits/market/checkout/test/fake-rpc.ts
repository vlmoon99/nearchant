// A fake NEAR RPC as a fetch function: views answer from `views["contract.method"]`, view_account from `accounts`.
import type { FetchLike } from "../src/rpc.js";

export type ViewFn = (args: Record<string, unknown>) => unknown;
export interface FakeRpc { fetch: FetchLike; calls: { method: string; contract?: string; fn?: string; args?: Record<string, unknown>; finality?: string }[] }

export function fakeRpc(views: Record<string, ViewFn>, accounts: Set<string> = new Set()): FakeRpc {
  const calls: FakeRpc["calls"] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { method: string; params: Record<string, string> };
    const p = body.params;
    const reply = (j: unknown) => ({ ok: true, status: 200, json: async () => j });
    if (p.request_type === "view_account") {
      calls.push({ method: "view_account", contract: p.account_id, finality: p.finality });
      return accounts.has(p.account_id!) ? reply({ result: { amount: "1" } }) : reply({ error: { cause: { name: "UNKNOWN_ACCOUNT" }, data: p.account_id } });
    }
    const args = JSON.parse(Buffer.from(p.args_base64!, "base64").toString()) as Record<string, unknown>;
    calls.push({ method: "call_function", contract: p.account_id, fn: p.method_name, args, finality: p.finality });
    const v = views[`${p.account_id}.${p.method_name}`];
    if (!v) return reply({ error: { cause: { name: "UNKNOWN_METHOD" }, data: p.method_name } });
    const out = v(args);
    return reply({ result: { result: Array.from(Buffer.from(JSON.stringify(out ?? null))) } });
  };
  return { fetch, calls };
}
