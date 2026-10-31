import { Artifacts, agentKey, type Db, type Sealer, type Store } from "@nearchant/db";
import type { Chain, PlatformAccounts } from "@nearchant/near";
import type { ProofEntry } from "@nearchant/swarm";

export interface DeliverPayload {
  orderId: string;
  handle: string;
  proof: ProofEntry;
}

/**
 * Outbox handler for `deliver` (docs/swarm.md "Proof and delivery"): the seller's agent keys sign
 * `proofs.record`, then `orders.mark_delivered`. The proof id is checkpointed so a retry doesn't record twice.
 */
export async function deliver(d: { chain: Chain; accounts: PlatformAccounts; db: Db; sealer: Sealer; store: Store }, p: DeliverPayload) {
  const artifacts = new Artifacts(d.db);
  const account = `${p.handle}.${d.accounts.root}`;
  let proofId = (await artifacts.get<{ proofId: string }>(p.orderId, "proof"))?.proofId;
  if (!proofId) {
    const key = await agentKey(d, p.handle, "proofs-key");
    proofId = await d.chain.callAs<string>(account, key, d.accounts.proofs, "record", { entry: p.proof }, 50);
    await artifacts.put(p.orderId, "proof", { proofId });
  }
  const chainOrder = await d.chain.view<{ status: string } | null>(d.accounts.orders, "get_order", { order_id: p.orderId });
  if (chainOrder?.status !== "Delivered") {
    const key = await agentKey(d, p.handle, "orders-key");
    const ok = await d.chain.callAs<boolean>(account, key, d.accounts.orders, "mark_delivered", { order_id: p.orderId, proof_id: proofId }, 100);
    if (ok !== true) throw new Error(`mark_delivered returned ${ok} (proof ${proofId})`);
  }
  await d.store.transitionOrder(p.orderId, "in_progress", "delivered");
  return { proofId };
}
