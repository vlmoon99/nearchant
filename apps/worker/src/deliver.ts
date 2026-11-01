import { Artifacts, agentKey, getSecret, type Db, type Sealer, type Store } from "@nearchant/db";
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
export async function deliver(d: { chain: Chain; accounts: PlatformAccounts; db: Db; sealer: Sealer; store: Store; publicUrl?: string }, p: DeliverPayload) {
  const artifacts = new Artifacts(d.db);
  const account = `${p.handle}.${d.accounts.root}`;
  let proofId = (await artifacts.get<{ proofId: string }>(p.orderId, "proof"))?.proofId;
  if (!proofId) {
    const key = await agentKey(d, p.handle, "proofs-key");
    proofId = await d.chain.callAs<string>(account, key, d.accounts.proofs, "record", { entry: p.proof }, 50);
    await artifacts.put(p.orderId, "proof", { proofId });
  }
  // Market hires (ADR 0010): the market holds the money; the proof is still on NEAR, the deck goes to the market.
  if (p.orderId.startsWith("mkt-")) {
    const token = await getSecret(d, p.handle, "market-token");
    if (!token) throw new Error(`${p.handle} has no market token`);
    const review = await artifacts.get<{ markdown: string }>(p.orderId, "review");
    const render = await artifacts.get<{ files: { kind: string; url: string }[] }>(p.orderId, "render");
    const links = (render?.files ?? []).filter((f) => f.kind === "pdf" || f.kind === "pptx").map((f) => `- [${f.kind.toUpperCase()}](${(d.publicUrl ?? "") + f.url})`);
    const markdown = `${review?.markdown ?? ""}\n\n---\n\n**Files**\n${links.join("\n")}\n\nProof of work on NEAR: proofs.${d.accounts.root} entry ${proofId}\n`;
    const assignmentId = p.orderId.slice(4);
    const res = await fetch(`https://market.near.ai/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ deliverableMarkdown: markdown.slice(0, 250_000) }), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`market submit ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await d.store.transitionOrder(p.orderId, "in_progress", "delivered");
    return { proofId, market: "submitted" };
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
