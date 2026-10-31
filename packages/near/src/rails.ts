import type { Viewer } from "./chain.js";
import type { PlatformAccounts } from "./accounts.js";

export interface OrderRequest {
  orderId: string;
  sellerHandle: string;
  /** Token base units (U128 string). */
  amount: string;
}

/** What the buyer's client must sign to pay. The gateway never signs for a buyer. */
export interface PaymentInstruction {
  rail: string;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  depositYocto: string;
  gasTgas: number;
}

export interface OrderStatus {
  status: string;
  amount: string;
  buyer_id: string;
  seller_handle: string;
}

/** ADR 0004. Every rail ends in the `orders` contract; order state is always read from chain. */
export interface PaymentRail {
  readonly id: string;
  instruction(order: OrderRequest): PaymentInstruction;
  status(orderId: string): Promise<OrderStatus | null>;
}

/** Testnet: the buyer calls `nusd.ft_transfer_call` → `orders` with the order id (free, ADR 0001). */
export class TestnetDirectRail implements PaymentRail {
  readonly id = "testnet-direct";
  constructor(private readonly accounts: PlatformAccounts, private readonly view: Viewer) {}

  instruction(o: OrderRequest): PaymentInstruction {
    if (!/^[0-9]+$/.test(o.amount) || o.amount === "0") throw new Error("amount must be a positive integer string");
    return {
      rail: this.id,
      receiverId: this.accounts.nusd,
      methodName: "ft_transfer_call",
      args: {
        receiver_id: this.accounts.orders,
        amount: o.amount,
        msg: JSON.stringify({ order_id: o.orderId, seller_handle: o.sellerHandle }),
      },
      depositYocto: "1",
      gasTgas: 150,
    };
  }

  status(orderId: string) {
    return this.view<OrderStatus | null>(this.accounts.orders, "get_order", { order_id: orderId });
  }
}

export interface DryQuote {
  originAsset: string;
  amountIn: string;
  amountInFormatted?: string;
  amountOut: string;
  timeEstimateSec?: number;
}

/**
 * NEAR Intents 1Click **dry** quote (mainnet only, no funds move): "you would pay X of asset A on chain B".
 * Shown at testnet checkout so the any-chain experience is visible (ADR 0004). Display only: failures return null.
 */
export async function oneClickDryQuote(p: {
  originAsset: string;
  destinationAsset: string;
  amountOut: string;
  recipient: string;
  /** Dry quotes don't know the buyer's address: refunds go to `refundTo` inside Intents (a NEAR account). */
  refundTo: string;
  jwt?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<DryQuote | null> {
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAsset,
    amount: p.amountOut,
    refundTo: p.refundTo,
    refundType: "INTENTS",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  try {
    const res = await (p.fetchFn ?? fetch)(`${p.baseUrl ?? "https://1click.chaindefuser.com"}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(p.jwt ? { authorization: `Bearer ${p.jwt}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { quote?: Record<string, unknown> };
    const q = j.quote;
    if (!q?.amountIn) return null;
    return {
      originAsset: p.originAsset,
      amountIn: String(q.amountIn),
      amountInFormatted: q.amountInFormatted ? String(q.amountInFormatted) : undefined,
      amountOut: String(q.amountOut ?? p.amountOut),
      timeEstimateSec: typeof q.timeEstimate === "number" ? q.timeEstimate : undefined,
    };
  } catch {
    return null;
  }
}
