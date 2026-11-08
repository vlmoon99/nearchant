import { randomUUID } from "node:crypto";
import { rpcView, type Network, type Signer, type View } from "./near.js";
import { retry, withTimeout } from "./retry.js";
import { EscrowError, parseOrder, parseParams, type Order, type Params } from "./types.js";

export interface EscrowOptions {
  /** The escrow contract account, e.g. `escrow.yourname.testnet`. */
  contractId: string;
  network?: Network;
  /** Your RPC endpoints (default: public ones for `network`). */
  rpcUrls?: string[];
  /** Read calls. Default: JSON-RPC via near-api-js. Pass your own (or a fake in tests). */
  view?: View;
  /** Who signs calls by default. Switch per call with `.as(otherSigner)`. */
  signer?: Signer;
  /** Per request (default 15 s for reads, 60 s for transactions). */
  timeoutMs?: number;
  txTimeoutMs?: number;
  /** Retries for reads (default 3) and the first backoff delay (default 300 ms). Transactions are never blindly retried. */
  retries?: number;
  retryDelayMs?: number;
}

export interface PayInput {
  /** Your idempotency key: the same id never charges twice (see `newOrderId`). 1..128 chars. */
  orderId: string;
  /** The seller's NEAR account (or a handle, if the contract was set up with a registry). */
  seller: string;
  /** The NEP-141 token contract, e.g. `nusd.nearchant.testnet`. Must be on the escrow's accepted list. */
  token: string;
  /** Token base units as a decimal string (U128), e.g. "5000000" = 5 USDC at 6 decimals. */
  amount: string;
  /** If the escrow isn't registered on the token yet, pay its storage deposit first (default false: throw). */
  ensureStorage?: boolean;
}

export interface PayResult {
  /** True when the escrow kept the money and the order is on chain. */
  paid: boolean;
  /** The order already existed for this buyer, so nothing was sent again. */
  alreadyPaid: boolean;
  /** Amount the escrow kept ("0" = everything went back to the buyer). */
  used: string;
  order: Order | null;
}

const TGAS = 10n ** 12n;
const ONE_YOCTO = 1n;

/** A fresh order id to use as the idempotency key. Store it with your order before paying. */
export function newOrderId(prefix = "ord"): string {
  return `${prefix}_${randomUUID()}`;
}

/** Client for the escrow contract: pay, deliver, accept, refunds, and reads. */
export class EscrowClient {
  readonly contractId: string;
  private readonly view: View;

  constructor(private readonly opts: EscrowOptions) {
    if (!opts.contractId) throw new EscrowError("contractId is required");
    this.contractId = opts.contractId;
    this.view = opts.view ?? rpcView({ network: opts.network, rpcUrls: opts.rpcUrls, timeoutMs: opts.timeoutMs, retries: 0 });
  }

  /** The same client, signing as someone else (e.g. `escrow.as(buyer).pay(…)`, `escrow.as(seller).markDelivered(…)`). */
  as(signer: Signer): EscrowClient {
    return new EscrowClient({ ...this.opts, view: this.view, signer });
  }

  // ---- reads ----

  async getOrder(orderId: string): Promise<Order | null> {
    return parseOrder(await this.read(this.contractId, "get_order", { order_id: orderId }));
  }

  async getParams(): Promise<Params> {
    return parseParams(await this.read(this.contractId, "get_params", {}));
  }

  // ---- buyer ----

  /**
   * Pays into escrow with `ft_transfer_call` (the order is created by the token's callback). Idempotent by `orderId`:
   * if the order is already on chain for this buyer nothing is sent; if the send fails or times out, the chain is
   * checked before reporting an error, because the transaction may have landed anyway.
   */
  async pay(input: PayInput): Promise<PayResult> {
    const signer = this.need();
    checkOrderId(input.orderId);
    if (!input.seller || input.seller.length > 64) throw new EscrowError("seller must be 1..64 chars");
    if (!input.token) throw new EscrowError("token is required");
    if (typeof input.amount !== "string" || !/^[1-9]\d*$/.test(input.amount)) {
      throw new EscrowError("amount must be a positive integer string in token base units (U128), e.g. \"5000000\"");
    }

    const existing = await this.getOrder(input.orderId);
    if (existing) return this.paidAlready(existing, signer.accountId, input.orderId);

    await this.checkStorage(input.token, input.ensureStorage ?? false, signer);

    const msg = JSON.stringify({ order_id: input.orderId, seller: input.seller });
    let used: unknown;
    try {
      used = await this.send(signer, input.token, "ft_transfer_call", { receiver_id: this.contractId, amount: input.amount, msg }, 150, ONE_YOCTO);
    } catch (e) {
      // The transaction may have gone through even though we didn't hear back: look before failing.
      const landed = await this.getOrder(input.orderId).catch(() => null);
      if (landed && landed.buyer_id === signer.accountId) return { paid: true, alreadyPaid: false, used: landed.amount, order: landed };
      throw e;
    }
    const usedStr = typeof used === "string" && /^\d+$/.test(used) ? used : "0";
    // Optimistic reads can trail the transaction by a block or two.
    const order = usedStr === "0" ? null : await retry(async () => {
      const o = await this.getOrder(input.orderId);
      if (!o) throw new EscrowError("order not visible yet");
      return o;
    }, { retries: 4, retryDelayMs: this.opts.retryDelayMs ?? 500 }).catch(() => null);
    return { paid: usedStr !== "0", alreadyPaid: false, used: usedStr, order };
  }

  /** Buyer confirms delivery: pays the seller (minus the platform fee). Returns false if the payout transfer failed. */
  accept(orderId: string): Promise<boolean> { return this.act("accept", { order_id: orderId }); }
  /** Buyer asks for a fix after delivery (limited by the contract's `max_revisions`). */
  requestRevision(orderId: string): Promise<boolean> { return this.act("request_revision", { order_id: orderId }, 30); }
  /** Buyer asks for the money back (only after using the revisions). */
  requestRefund(orderId: string): Promise<boolean> { return this.act("request_refund", { order_id: orderId }, 30); }

  // ---- seller ----

  /** Seller marks the order delivered. `proofId` is needed only if the escrow checks a proof log. */
  markDelivered(orderId: string, proofId?: string): Promise<boolean> {
    return this.act("mark_delivered", { order_id: orderId, proof_id: proofId ?? null });
  }
  /** Seller refunds the buyer in full: after a refund request or dispute, or to decline an undelivered order. */
  approveRefund(orderId: string): Promise<boolean> { return this.act("approve_refund", { order_id: orderId }); }
  /** Seller declines a refund request: the order becomes Disputed (sort it out off chain; you can still refund). */
  declineRefund(orderId: string): Promise<boolean> { return this.act("decline_refund", { order_id: orderId }, 30); }

  // ---- anyone (run on a timer) ----

  /** Pays out a delivered order whose release window has passed. */
  releaseExpired(orderId: string): Promise<boolean> { return this.act("release_expired", { order_id: orderId }); }
  /** Refunds an order the seller didn't deliver by its deadline. */
  refundUndelivered(orderId: string): Promise<boolean> { return this.act("refund_undelivered", { order_id: orderId }); }

  // ---- internals ----

  private need(): Signer {
    if (!this.opts.signer) throw new EscrowError("no signer: pass `signer` or use `.as(signer)`");
    return this.opts.signer;
  }

  private read(contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    return retry(() => withTimeout(this.view(contractId, method, args), this.opts.timeoutMs ?? 15_000, `view ${method}`), {
      retries: this.opts.retries, retryDelayMs: this.opts.retryDelayMs,
    });
  }

  private async send(signer: Signer, contractId: string, methodName: string, args: Record<string, unknown>, gasTgas: number, deposit = 0n) {
    try {
      return await withTimeout(signer.call({ contractId, methodName, args, gas: BigInt(gasTgas) * TGAS, deposit }), this.opts.txTimeoutMs ?? 60_000, methodName);
    } catch (e) {
      throw new EscrowError(`${methodName} failed: ${panicText(e)}`, e);
    }
  }

  /**
   * One state-changing call. Not retried: the contract's state machine rejects repeats anyway (accepting twice fails
   * with "order not delivered"), so on a timeout read `getOrder` and decide.
   */
  private async act(method: string, args: Record<string, unknown>, gasTgas = 100): Promise<boolean> {
    const r = await this.send(this.need(), this.contractId, method, args, gasTgas);
    return r === undefined || r === null ? true : r !== false;
  }

  private paidAlready(o: Order, buyer: string, orderId: string): PayResult {
    if (o.buyer_id !== buyer) throw new EscrowError(`order id ${orderId} is already used by another buyer`);
    return { paid: true, alreadyPaid: true, used: o.amount, order: o };
  }

  /** ft_transfer_call fails if the escrow has no storage on the token, so check (and optionally fix) that first. */
  private async checkStorage(token: string, ensure: boolean, signer: Signer) {
    const bal = await this.read(token, "storage_balance_of", { account_id: this.contractId });
    if (bal) return;
    if (!ensure) throw new EscrowError(`${this.contractId} is not registered on ${token}: call storage_deposit, or pay with ensureStorage: true`);
    const bounds = await this.read(token, "storage_balance_bounds", {});
    const min = (bounds as { min?: unknown } | null)?.min;
    if (typeof min !== "string" || !/^\d+$/.test(min)) throw new EscrowError(`${token} returned bad storage bounds`);
    await this.send(signer, token, "storage_deposit", { account_id: this.contractId, registration_only: true }, 30, BigInt(min));
  }
}

function checkOrderId(id: string) {
  if (typeof id !== "string" || id.length < 1 || id.length > 128) throw new EscrowError("orderId must be 1..128 chars");
}

/** The contract's panic message if there is one ("seller only"), else the error text. */
function panicText(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const m = msg.match(/Smart contract panicked: ([^"\n]+)/);
  return m ? m[1]!.trim() : msg;
}
