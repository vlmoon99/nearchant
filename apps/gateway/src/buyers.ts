import { PublicKey } from "near-api-js";
import type { Chain, PlatformAccounts } from "@nearchant/near";

/** Implicit account id of an ed25519 public key: 64 hex chars (NEAR's implicit accounts). */
export function implicitAccountId(publicKey: string): string {
  const pk = PublicKey.fromString(publicKey);
  if (pk.keyType !== 0) throw new Error("ed25519 keys only");
  return Buffer.from(pk.data).toString("hex");
}

export class RateLimited extends Error {
  constructor() {
    super("too many new test wallets; try later");
  }
}

/** Client address for rate limits. Proxy headers are trusted only when TRUST_PROXY says a proxy sets them (M3). */
export function clientIp(header: (name: string) => string | undefined, socketAddress: string | undefined, trust = process.env.TRUST_PROXY): string {
  if (trust === "cloudflare") return header("cf-connecting-ip") ?? socketAddress ?? "unknown";
  if (trust === "forwarded") return header("x-forwarded-for")?.split(",")[0]?.trim() ?? socketAddress ?? "unknown";
  return socketAddress ?? "unknown";
}

/** Simple fixed-window limiter per key (IP). In-memory: fine for one gateway; Postgres-backed later. */
export class RateLimit {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.until < t) this.hits.delete(k);
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
export async function sponsorBuyer(d: { chain: Chain; accounts: PlatformAccounts }, publicKey: string, allowNew: () => boolean, gasNear = "0.2") {
  const accountId = implicitAccountId(publicKey);
  const exists = await d.chain.accountExists(accountId);
  // Limits are checked BEFORE any NEAR leaves the relayer (security review H1).
  if (!exists && !allowNew()) throw new RateLimited();
  if (!exists) await d.chain.transferFromRelayer(accountId, gasNear);
  let funded = true;
  await d.chain.call(d.accounts.nusd, "faucet_for", { account_id: accountId }, { gasTgas: 30 }).catch(() => { funded = false; });
  return { accountId, created: !exists, funded };
}
