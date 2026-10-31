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

  constructor(readonly opts: ChainOptions) {
    if (opts.rpcUrls.length === 0) throw new Error("Chain needs at least one RPC URL");
    const timeout = opts.timeoutMs ?? 15_000;
    this.provider = new FailoverRpcProvider(opts.rpcUrls.map((url) => new JsonRpcProvider({ url, timeout } as never)));
    if (opts.relayer) {
      const signer = KeyPairSigner.fromSecretKey(opts.relayer.secretKey as KeyPairString);
      this.relayerAccount = new Account(opts.relayer.accountId, this.provider, signer);
    }
  }

  view: Viewer = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}) => {
    return (await this.provider.callFunction({ contractId, method, args, finality: "optimistic" } as never)) as T;
  };

  get relayerId(): string | undefined {
    return this.relayerAccount?.accountId;
  }

  /** A function call signed by the relayer. Returns the decoded return value. */
  async call<T = unknown>(contractId: string, methodName: string, args: Record<string, unknown>, opts: { gasTgas?: number; depositYocto?: bigint } = {}): Promise<T> {
    if (!this.relayerAccount) throw new Error("no relayer key configured");
    return (await this.relayerAccount.callFunction({
      contractId,
      methodName,
      args,
      gas: BigInt(opts.gasTgas ?? 100) * 10n ** 12n,
      deposit: opts.depositYocto ?? 0n,
    })) as T;
  }
}
