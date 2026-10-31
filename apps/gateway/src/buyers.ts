import { PublicKey } from "near-api-js";
import type { Chain, PlatformAccounts } from "@nearchant/near";

/** Implicit account id of an ed25519 public key: 64 hex chars (NEAR's implicit accounts). */
export function implicitAccountId(publicKey: string): string {
  const pk = PublicKey.fromString(publicKey);
  if (pk.keyType !== 0) throw new Error("ed25519 keys only");
  return Buffer.from(pk.data).toString("hex");
}

/** Simple fixed-window limiter per key (IP). In-memory: fine for one gateway; Postgres-backed later. */
export class RateLimit {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.until < t) {
      this.hits.set(key, { n: 1, until: t + this.windowMs });
      return true;
    }
    if (h.n >= this.max) return false;
    h.n++;
    return true;
  }
}

/**
 * Testnet buyer sponsorship (ADR 0001): the buyer's browser makes a key; the relayer funds its implicit account
 * with a little NEAR for gas and asks the nUSD faucet for test money. The buyer keeps the only key.
 */
export async function sponsorBuyer(d: { chain: Chain; accounts: PlatformAccounts }, publicKey: string, gasNear = "0.05") {
  const accountId = implicitAccountId(publicKey);
  const exists = await d.chain.provider.viewAccount({ accountId, finality: "optimistic" } as never).then(() => true, () => false);
  if (!exists) await d.chain.transferFromRelayer(accountId, gasNear);
  let funded = true;
  await d.chain.call(d.accounts.nusd, "faucet_for", { account_id: accountId }, { gasTgas: 30 }).catch(() => { funded = false; });
  return { accountId, created: !exists, funded };
}
