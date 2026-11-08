// The only file that touches near-api-js. Everything else talks to the two small interfaces below, so tests can
// pass fakes and you can plug in any wallet (wallet selector, MPC signer, a backend relayer).
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { retry, withTimeout, type RetryOptions } from "./retry.js";

export type Network = "testnet" | "mainnet";

/** A read-only contract call. Returns the decoded JSON result. */
export type View = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

/** Signs and sends one function call as `accountId`. Returns the decoded JSON return value (or undefined). */
export interface Signer {
  accountId: string;
  call(p: { contractId: string; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }): Promise<unknown>;
}

/** Public RPCs; pass your own `rpcUrls` for production (public ones are rate limited). */
export const DEFAULT_RPC: Record<Network, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

export interface RpcOptions {
  network?: Network;
  rpcUrls?: string[];
}

/** A near-api-js provider; with several URLs it fails over between them. */
export function rpcProvider(o: RpcOptions = {}) {
  const urls = o.rpcUrls?.length ? o.rpcUrls : DEFAULT_RPC[o.network ?? "testnet"];
  const providers = urls.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 300, backoff: 2 }));
  return providers.length === 1 ? providers[0]! : new FailoverRpcProvider(providers);
}

/** View calls over JSON-RPC, each with a timeout and retried with backoff (reads are always safe to retry). */
export function rpcView(o: RpcOptions & { timeoutMs?: number } & RetryOptions = {}): View {
  const provider = rpcProvider(o);
  return (contractId, method, args) =>
    retry(() => withTimeout(provider.callFunction({ contractId, method, args }) as Promise<unknown>, o.timeoutMs ?? 15_000, `view ${method}`), o);
}

/** A signer from a near-api-js `Account` that already has a signer (e.g. from your wallet code). */
export function accountSigner(account: Account): Signer {
  return {
    accountId: account.accountId,
    call: ({ contractId, methodName, args, gas, deposit }) => account.callFunction({ contractId, methodName, args, gas, deposit }),
  };
}

/** A signer from an account id and its secret key (`ed25519:…`). Keep keys in a secret store, not in code. */
export function keySigner(o: RpcOptions & { accountId: string; secretKey: string }): Signer {
  const account = new Account(o.accountId, rpcProvider(o), KeyPairSigner.fromSecretKey(o.secretKey as KeyPairString));
  return accountSigner(account);
}
