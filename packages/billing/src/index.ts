import type { ResultEnvelope, UsageRecord } from "@nearchant/contracts";
import { canonical, sha256 } from "@nearchant/providers";

export interface PricingPolicy {
  /** Gateway margin on top of provider cost, in basis points (1000 = 10%). Shown on statements. */
  marginBps: number;
  /** Token base units per 1 USD (nUSD / USDC: 1e6). */
  unitsPerUsd: number;
}

/** Charge for one call in token base units: provider cost + margin, rounded up. Local calls are free. */
export function chargeUnits(e: Pick<ResultEnvelope, "costUsd" | "privacyTier">, p: PricingPolicy): bigint {
  if (e.privacyTier === "local" || e.costUsd <= 0) return 0n;
  // Integer math: cost in nano-USD × units/USD × (1 + margin), rounded up.
  const nano = BigInt(Math.round(e.costUsd * 1e9));
  const num = nano * BigInt(p.unitsPerUsd) * BigInt(10_000 + p.marginBps);
  const den = 1_000_000_000n * 10_000n;
  return (num + den - 1n) / den;
}

export function usageRecord(id: string, accountId: string, e: ResultEnvelope, p: PricingPolicy): UsageRecord {
  return {
    recordId: id, accountId, capability: e.capability, endpointId: e.endpointId, model: e.model, usage: e.usage,
    costUsd: e.costUsd, chargeUnits: chargeUnits(e, p).toString(), requestHash: e.requestHash, createdAt: e.createdAt,
  };
}

/** Leaf = sha256 of the canonical JSON of a record without its signature. */
export function leafHash(r: UsageRecord): string {
  const { signature: _, ...rest } = r;
  return sha256(canonical(rest));
}

/** Binary Merkle root over hex leaves (sha256 of the two child bytes; an odd last node is paired with itself). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256("");
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(Buffer.from(sha256(Buffer.concat([a, b])), "hex"));
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

/** Proof path for leaf `index`: sibling hashes bottom-up, so a seller can check one charge against the root. */
export function merkleProof(leaves: string[], index: number): { sibling: string; right: boolean }[] {
  const path: { sibling: string; right: boolean }[] = [];
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex"));
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sib = isRight ? level[i - 1]! : (level[i + 1] ?? level[i]!);
    path.push({ sibling: sib.toString("hex"), right: !isRight });
    const next: Buffer[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(Buffer.from(sha256(Buffer.concat([level[j]!, level[j + 1] ?? level[j]!])), "hex"));
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

export function verifyProof(leaf: string, path: { sibling: string; right: boolean }[], root: string): boolean {
  let h: Buffer = Buffer.from(leaf, "hex");
  for (const p of path) {
    const s = Buffer.from(p.sibling, "hex");
    h = Buffer.from(sha256(p.right ? Buffer.concat([h, s]) : Buffer.concat([s, h])), "hex");
  }
  return h.toString("hex") === root;
}

export interface Batch {
  batchId: string;
  merkleRoot: string;
  records: UsageRecord[];
  /** Per-account totals for `billing.settle_batch` (only accounts with a non-zero charge). */
  entries: { account_id: string; amount: string }[];
}

/** Builds a settlement batch from records. Zero-charge records are kept in the tree (the statement shows them). */
export function buildBatch(batchId: string, records: UsageRecord[]): Batch {
  const totals = new Map<string, bigint>();
  for (const r of records) totals.set(r.accountId, (totals.get(r.accountId) ?? 0n) + BigInt(r.chargeUnits));
  return {
    batchId,
    merkleRoot: merkleRoot(records.map(leafHash)),
    records,
    entries: [...totals].filter(([, v]) => v > 0n).map(([account_id, v]) => ({ account_id, amount: v.toString() })),
  };
}
