import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";

export interface ChainOptions {
  /** Several RPC URLs: the provider fails over between them (unstable networks are normal). */
  rpcUrls: string[];
  /** Relayer account and its function-call or full key (from compose/Phala secrets, never the repo). */
  relayer?: { accountId: string; secretKey: string };
  timeoutMs?: number;
}

export type Viewer = <T>(contractId: string, method: string, args?: Record<string, unknown>) => Promise<T>;

/** Thin wrapper over near-api-js: views for anyone, function calls signed by the relayer. */
export class Chain {
  readonly provider: FailoverRpcProvider;
  private relayerAccount?: Account;
  private relayerSigner?: KeyPairSigner;

  constructor(readonly opts: ChainOptions) {
    if (opts.rpcUrls.length === 0) throw new Error("Chain needs at least one RPC URL");
    const timeout = opts.timeoutMs ?? 15_000;
    this.provider = new FailoverRpcProvider(opts.rpcUrls.map((url) => new JsonRpcProvider({ url, timeout } as never)));
    if (opts.relayer) {
      this.relayerSigner = KeyPairSigner.fromSecretKey(opts.relayer.secretKey as KeyPairString);
      this.relayerAccount = new Account(opts.relayer.accountId, this.provider, this.relayerSigner);
    }
  }

  view: Viewer = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}) => {
    return (await this.provider.callFunction({ contractId, method, args, finality: "optimistic" } as never)) as T;
  };

  get relayerId(): string | undefined {
    return this.relayerAccount?.accountId;
  }

  /** Whether an account exists (plain JSON-RPC, so a missing account isn't logged as an error). */
  async accountExists(accountId: string): Promise<boolean> {
    for (const url of this.opts.rpcUrls) {
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: accountId } }),
        });
        const j = (await res.json()) as { result?: unknown; error?: { cause?: { name?: string } } };
        if (j.result) return true;
        if (j.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
      } catch {
        /* next RPC */
      }
    }
    throw new Error(`could not check ${accountId}: all RPCs failed`);
  }

  /**
   * Several processes (gateway, worker) sign with the relayer key, so a cached nonce can be stale. On a nonce
   * error, re-create the account (fresh nonce from chain) and retry.
   */
  private async withRelayer<T>(fn: (a: Account) => Promise<T>): Promise<T> {
    if (!this.relayerAccount || !this.relayerSigner) throw new Error("no relayer key configured");
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(this.relayerAccount);
      } catch (e) {
        // near-api-js errors carry BigInt fields: a plain JSON.stringify throws and would hide the real error.
        let detail = "";
        try { detail = JSON.stringify(e ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)); } catch { /* keep the message */ }
        const msg = String((e as Error)?.message ?? e) + detail;
        if (attempt >= 4 || !/nonce/i.test(msg)) throw e;
        this.relayerAccount = new Account(this.relayerAccount.accountId, this.provider, this.relayerSigner);
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
      }
    }
  }

  /** Sends NEAR from the relayer (creates an implicit account if it doesn't exist). */
  async transferFromRelayer(receiverId: string, amountNear: string): Promise<void> {
    const [w, f = ""] = amountNear.split(".");
    const yocto = BigInt(w!) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24));
    await this.withRelayer((a) => a.transfer({ receiverId, amount: yocto } as never));
  }

  /** A function call signed by another account's key (e.g. a seller's agent function-call key). */
  async callAs<T = unknown>(accountId: string, secretKey: string, contractId: string, methodName: string, args: Record<string, unknown>, gasTgas = 100, depositYocto = 0n): Promise<T> {
    const account = new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(secretKey as KeyPairString));
    return (await account.callFunction({ contractId, methodName, args, gas: BigInt(gasTgas) * 10n ** 12n, deposit: depositYocto })) as T;
  }

  /** A function call signed by the relayer. Returns the decoded return value. */
  async call<T = unknown>(contractId: string, methodName: string, args: Record<string, unknown>, opts: { gasTgas?: number; depositYocto?: bigint } = {}): Promise<T> {
    return (await this.withRelayer((a) => a.callFunction({
      contractId,
      methodName,
      args,
      gas: BigInt(opts.gasTgas ?? 100) * 10n ** 12n,
      deposit: opts.depositYocto ?? 0n,
    }))) as T;
  }
}
