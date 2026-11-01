import { KeyPair } from "near-api-js";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Db } from "./pg.js";
import type { Sealer } from "./seal.js";
import { validHandle, type Chain, type PlatformAccounts } from "@nearchant/near";

/** Agent keys a sponsored shop gets: function-call only, each scoped to one platform contract (docs/swarm.md). */
export const AGENT_KEYS = (a: PlatformAccounts) => [
  { name: "proofs-key", receiver_id: a.proofs, method_names: ["record"] },
  { name: "orders-key", receiver_id: a.orders, method_names: ["mark_delivered", "approve_refund", "decline_refund"] },
  { name: "escrow-key", receiver_id: a.escrow, method_names: ["pay"] },
] as const;

export interface CreateShop {
  handle: string;
  /** The seller's own key (generated in their browser). Becomes the only full-access key. */
  ownerPublicKey: string;
  card: { name: string; bio: string; avatar_hash: string | null; links: string[] };
}

/**
 * Sponsored shop creation (ADR 0001): `handles.claim_for` via the relayer creates `<handle>.<root>` owned by the
 * seller's key, plus agent function-call keys whose secrets are sealed in Postgres. Then the account is
 * registered and funded on nUSD so it can receive payouts and top up billing.
 */
export async function createShop(d: { chain: Chain; accounts: PlatformAccounts; db: Db; sealer: Sealer }, s: CreateShop) {
  if (!validHandle(s.handle)) throw new Error("invalid handle");
  const available = await d.chain.view<boolean>(d.accounts.root, "is_available", { name: s.handle });
  if (!available) throw new Error("handle is taken or reserved");

  const keys = AGENT_KEYS(d.accounts).map((k) => ({ ...k, pair: KeyPair.fromRandom("ed25519") }));
  // Seal first: if the chain call succeeds and we crash, the keys are not lost.
  for (const k of keys) {
    const sealed = d.sealer.seal(k.pair.toString(), `${s.handle}/${k.name}`);
    await d.db.insert(schema.sellerSecrets).values({ handle: s.handle, name: k.name, sealed })
      .onConflictDoUpdate({ target: [schema.sellerSecrets.handle, schema.sellerSecrets.name], set: { sealed, updatedAt: new Date() } });
  }
  const created = await d.chain.call<boolean>(d.accounts.root, "claim_for", {
    handle: s.handle,
    public_key: s.ownerPublicKey,
    card: s.card,
    agent_keys: keys.map((k) => ({ public_key: k.pair.getPublicKey().toString(), receiver_id: k.receiver_id, method_names: k.method_names })),
  }, { gasTgas: 150 });
  if (created === false) throw new Error("account creation failed (refunded)");
  const accountId = `${s.handle}.${d.accounts.root}`;
  await d.chain.call(d.accounts.nusd, "faucet_for", { account_id: accountId }, { gasTgas: 30 });
  return { accountId };
}

/** The secret key of one of a shop's agent keys (decrypted in memory only). */
export async function agentKey(d: { db: Db; sealer: Sealer }, handle: string, name: "proofs-key" | "orders-key" | "escrow-key"): Promise<string> {
  const [r] = await d.db.select().from(schema.sellerSecrets).where(and(eq(schema.sellerSecrets.handle, handle), eq(schema.sellerSecrets.name, name)));
  if (!r) throw new Error(`no ${name} for ${handle}`);
  return d.sealer.open(r.sealed, `${handle}/${name}`);
}

/** Any sealed per-shop secret (bot token, webhook secret). */
export async function putSecret(d: { db: Db; sealer: Sealer }, handle: string, name: string, value: string): Promise<void> {
  const sealed = d.sealer.seal(value, `${handle}/${name}`);
  await d.db.insert(schema.sellerSecrets).values({ handle, name, sealed })
    .onConflictDoUpdate({ target: [schema.sellerSecrets.handle, schema.sellerSecrets.name], set: { sealed, updatedAt: new Date() } });
}

export async function getSecret(d: { db: Db; sealer: Sealer }, handle: string, name: string): Promise<string | null> {
  const [r] = await d.db.select().from(schema.sellerSecrets).where(and(eq(schema.sellerSecrets.handle, handle), eq(schema.sellerSecrets.name, name)));
  return r ? d.sealer.open(r.sealed, `${handle}/${name}`) : null;
}

export async function handlesWithSecret(d: { db: Db }, name: string): Promise<string[]> {
  const rows = await d.db.select({ handle: schema.sellerSecrets.handle }).from(schema.sellerSecrets).where(eq(schema.sellerSecrets.name, name));
  return rows.map((r) => r.handle);
}
