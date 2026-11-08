// Shapes the escrow contract returns, plus small validators: chain data is checked before it is used, not cast.

export const ORDER_STATUSES = [
  "Opening", "Held", "Delivered", "RevisionRequested", "RefundRequested", "Disputed", "Releasing", "Refunding", "Released", "Refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Amounts and times are decimal strings (U128 / U64): token base units and nanoseconds. */
export interface Order {
  order_id: string;
  buyer_id: string;
  seller: string;
  seller_id: string | null;
  payout_id: string | null;
  token_id: string;
  amount: string;
  status: OrderStatus;
  created_at: string;
  delivered_at: string | null;
  proof_id: string | null;
  revisions_used: number;
  release_after_ns: string;
  deliver_by: string;
  fee_bps: number;
}

export interface Params {
  release_after_ns: string;
  delivery_deadline_ns: string;
  max_revisions: number;
  accepted_tokens: string[];
  fee_bps: number;
  fee_account_id: string;
  min_amount: string;
  registry_id: string | null;
  proof_log_id: string | null;
}

export class EscrowError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EscrowError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string) => {
  if (typeof o[k] !== "string") throw new EscrowError(`bad contract data: ${k} is not a string`);
  return o[k] as string;
};
const optStr = (o: Record<string, unknown>, k: string) => (o[k] == null ? null : str(o, k));
const num = (o: Record<string, unknown>, k: string) => {
  if (typeof o[k] !== "number") throw new EscrowError(`bad contract data: ${k} is not a number`);
  return o[k] as number;
};
const digits = (o: Record<string, unknown>, k: string) => {
  const v = str(o, k);
  if (!/^\d+$/.test(v)) throw new EscrowError(`bad contract data: ${k} is not an integer string`);
  return v;
};

export function parseOrder(v: unknown): Order | null {
  if (v == null) return null;
  if (!isObj(v)) throw new EscrowError("bad contract data: order is not an object");
  const status = str(v, "status");
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) throw new EscrowError(`bad contract data: unknown status ${status}`);
  return {
    order_id: str(v, "order_id"), buyer_id: str(v, "buyer_id"), seller: str(v, "seller"),
    seller_id: optStr(v, "seller_id"), payout_id: optStr(v, "payout_id"), token_id: str(v, "token_id"),
    amount: digits(v, "amount"), status: status as OrderStatus, created_at: digits(v, "created_at"),
    delivered_at: optStr(v, "delivered_at"), proof_id: optStr(v, "proof_id"), revisions_used: num(v, "revisions_used"),
    release_after_ns: digits(v, "release_after_ns"), deliver_by: digits(v, "deliver_by"), fee_bps: num(v, "fee_bps"),
  };
}

export function parseParams(v: unknown): Params {
  if (!isObj(v)) throw new EscrowError("bad contract data: params is not an object");
  const tokens = v.accepted_tokens;
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "string")) throw new EscrowError("bad contract data: accepted_tokens");
  return {
    release_after_ns: digits(v, "release_after_ns"), delivery_deadline_ns: digits(v, "delivery_deadline_ns"),
    max_revisions: num(v, "max_revisions"), accepted_tokens: tokens as string[], fee_bps: num(v, "fee_bps"),
    fee_account_id: str(v, "fee_account_id"), min_amount: digits(v, "min_amount"),
    registry_id: optStr(v, "registry_id"), proof_log_id: optStr(v, "proof_log_id"),
  };
}
