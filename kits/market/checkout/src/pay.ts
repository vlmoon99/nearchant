// Pay an escrow contract with a NEP-141 token: (register the escrow on the token if needed) → ft_transfer_call with
// the order in `msg` → wait until the escrow shows the order as paid. Every step is reported through `onStep`.
//
// The order id is the idempotency key: before paying we ask the escrow whether this order is already paid, and the
// Nearchant escrow returns the money for a repeated order id, so "Try again" can never charge twice.
import { sleep as realSleep, viewCall, type RpcOptions } from "./rpc.js";
import { tokenBalance } from "./units.js";

export interface FunctionCall { contractId: string; methodName: string; args: Record<string, unknown>; deposit: bigint; gas: bigint }

/** Whatever can sign a function call for `accountId`: the test wallet, a near-api-js Account, a wallet-selector wallet. */
export interface Payer {
  accountId: string;
  /** Sends the call and resolves when it executed. May resolve with the method's return value. */
  call(c: FunctionCall): Promise<unknown>;
}

/** The structural part of a NEAR Wallet Selector wallet we use (no import, so any 8.x–10.x wallet fits). */
export interface SelectorWalletLike {
  signAndSendTransaction(p: { signerId?: string; receiverId?: string; actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[] }): Promise<unknown>;
}

/** A Payer from a signed-in NEAR Wallet Selector wallet (Meteor, HOT, MyNearWallet…). */
export function fromWalletSelector(wallet: SelectorWalletLike, accountId: string): Payer {
  return {
    accountId,
    call: (c) => wallet.signAndSendTransaction({
      signerId: accountId, receiverId: c.contractId,
      actions: [{ type: "FunctionCall", params: { methodName: c.methodName, args: c.args, gas: c.gas.toString(), deposit: c.deposit.toString() } }],
    }),
  };
}

export type PayStep = "wallet" | "pay" | "confirm";
export interface StepEvent { step: PayStep; state: "now" | "done" | "bad"; detail?: string }

/** What the escrow says about an order. "missing" = no such order (yet, or the escrow returned the money). */
export type PaidState = "paid" | "pending" | "missing";

export interface PayOptions extends RpcOptions {
  /** NEP-141 token contract, e.g. "usdc.fakes.testnet". */
  token: string;
  /** Escrow contract that implements ft_on_transfer. */
  escrow: string;
  /** Base units, integer string (U128). */
  amount: string;
  /** Unique per order; also the idempotency key. */
  orderId: string;
  /** Nearchant's escrow wants the seller handle in msg; other escrows may not. */
  /** The seller: a NEAR account (or a handle, when the escrow has a registry). Goes into the default msg. */
  seller?: string;
  /** The ft_transfer_call msg. Default: {"order_id", "seller"} (the escrow kit, kits/market/escrow). */
  msg?: string | ((orderId: string) => string);
  /** Who pays. A function is called once, inside the "wallet" step (e.g. `() => wallet.ready()`). */
  payer: Payer | (() => Promise<Payer>);
  onStep?: (e: StepEvent) => void;
  /** How to tell the order is paid. Default: escrow view `get_order({order_id})`, paid once status ≠ "Opening". */
  checkPaid?: (orderId: string) => Promise<PaidState>;
  /** Give up waiting (status "pending", not an error) after this long. Default 60 000. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  /** After the transfer, "missing" for this long means the escrow refused and returned the money. Default 15 000. */
  missingGraceMs?: number;
  /** Gas for ft_transfer_call in TGas. Default 100. */
  gasTgas?: number;
  /** Register the escrow on the token (storage_deposit) when it isn't. Default true. */
  registerEscrow?: boolean;
  /** Read the payer's token balance first and stop early when it's short. Default true. */
  checkBalance?: boolean;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PayResult {
  /** "pending": the transfer went through but the escrow hadn't shown it before the timeout. */
  status: "paid" | "pending";
  orderId: string;
  buyer: string;
  /** False when the order was already paid before this call (nothing was sent). */
  sent: boolean;
}

export type PayErrorCode = "not_enough_balance" | "rejected" | "refused" | "network" | "failed";
export class PayError extends Error {
  /** `maybeSent`: the transfer may have left the wallet (a retry is still safe: the order id is checked first). */
  constructor(readonly code: PayErrorCode, message: string, readonly maybeSent = false) {
    super(message);
    this.name = "PayError";
  }
}

/** The msg the escrow kit's contract reads in ft_on_transfer: {"order_id": "...", "seller": "alice.testnet"}.
 *  (Nearchant's own deployed orders contract uses "seller_handle" — pass `msg` to talk to it.) */
export const escrowMsg = (orderId: string, seller?: string) =>
  JSON.stringify(seller === undefined ? { order_id: orderId } : { order_id: orderId, seller });

interface EscrowOrder { status?: string; amount?: string; token_id?: string }

/** Default checkPaid: reads `get_order` on the escrow. Throws PayError("refused") if the order id holds a different payment. */
export function escrowCheckPaid(o: RpcOptions & { escrow: string; token: string; amount: string; method?: string }) {
  return async (orderId: string): Promise<PaidState> => {
    const order = await viewCall<EscrowOrder | null>(o.escrow, o.method ?? "get_order", { order_id: orderId }, o);
    if (!order) return "missing";
    if (order.status === "Opening") return "pending";
    if (order.amount !== o.amount || order.token_id !== o.token) throw new PayError("refused", "This order id already holds a different payment.");
    return "paid";
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
function classify(e: unknown, sent: boolean): PayError {
  if (e instanceof PayError) return e;
  const m = errText(e);
  if (/NotEnoughBalance|not enough balance|exceeds balance|insufficient|LackBalanceForState/i.test(m)) return new PayError("not_enough_balance", m, false);
  if (/reject|cancel|denied|closed the window|user closed/i.test(m)) return new PayError("rejected", m, false);
  if (/fetch|network|timeout|ETIMEDOUT|unreachable|50[234]|429/i.test(m)) return new PayError("network", m, sent);
  return new PayError("failed", m, sent);
}

export async function payWithEscrow(o: PayOptions): Promise<PayResult> {
  if (!/^[1-9]\d*$/.test(o.amount)) throw new PayError("failed", "amount must be a positive integer string (base units)");
  if (!o.orderId) throw new PayError("failed", "orderId is required");
  const sleep = o.sleep ?? realSleep, now = o.now ?? Date.now;
  const emit = (step: PayStep, state: StepEvent["state"], detail?: string) => o.onStep?.({ step, state, ...(detail === undefined ? {} : { detail }) });
  const checkPaid = o.checkPaid ?? escrowCheckPaid({ ...o });
  let step: PayStep = "wallet", sent = false;
  try {
    // 1. Wallet
    emit("wallet", "now");
    const payer = typeof o.payer === "function" ? await o.payer() : o.payer;
    if ((await checkPaid(o.orderId).catch(() => "missing" as const)) === "paid") {
      emit("wallet", "done"); emit("pay", "done", "already paid"); emit("confirm", "done");
      return { status: "paid", orderId: o.orderId, buyer: payer.accountId, sent: false };
    }
    if (o.checkBalance !== false) {
      const bal = await tokenBalance({ ...o, accountId: payer.accountId });
      if (bal !== null && bal < BigInt(o.amount)) throw new PayError("not_enough_balance", "Not enough money in the wallet for this.");
    }
    emit("wallet", "done");

    // 2. Pay
    step = "pay";
    emit("pay", "now");
    if (o.registerEscrow !== false) await registerIfNeeded(o, payer);
    const msg = typeof o.msg === "function" ? o.msg(o.orderId) : o.msg ?? escrowMsg(o.orderId, o.seller);
    // No automatic retry here: a timeout may still land. The caller's "Try again" re-runs and the check above sees it.
    sent = true;
    const used = await payer.call({
      contractId: o.token, methodName: "ft_transfer_call",
      args: { receiver_id: o.escrow, amount: o.amount, msg },
      deposit: 1n, gas: BigInt(o.gasTgas ?? 100) * 10n ** 12n,
    });
    // near-api-js returns ft_transfer_call's result: the amount the escrow kept. "0" = it gave everything back.
    if (typeof used === "string" && used === "0") throw new PayError("refused", "The escrow didn't accept this order and returned the money.", false);
    emit("pay", "done");

    // 3. Confirm
    step = "confirm";
    emit("confirm", "now");
    const t0 = now(), timeout = o.confirmTimeoutMs ?? 60_000, grace = o.missingGraceMs ?? 15_000;
    for (;;) {
      let s: PaidState = "pending";
      try { s = await checkPaid(o.orderId); } catch (e) { if (e instanceof PayError) throw e; /* RPC hiccup: keep waiting */ }
      if (s === "paid") { emit("confirm", "done"); return { status: "paid", orderId: o.orderId, buyer: payer.accountId, sent: true }; }
      const waited = now() - t0;
      if (s === "missing" && waited >= grace) throw new PayError("refused", "The escrow didn't record this order; the money goes back to the wallet.", false);
      if (waited >= timeout) { emit("confirm", "now", "taking longer than usual"); return { status: "pending", orderId: o.orderId, buyer: payer.accountId, sent: true }; }
      await sleep(o.pollMs ?? 2000);
    }
  } catch (e) {
    const err = classify(e, sent && step === "pay");
    emit(step, "bad", err.message);
    throw err;
  }
}

/** NEP-145: a token only credits registered accounts. Registers the escrow (once, ~0.00125 NEAR) if it isn't. */
async function registerIfNeeded(o: PayOptions, payer: Payer): Promise<void> {
  let reg: unknown;
  try { reg = await viewCall(o.token, "storage_balance_of", { account_id: o.escrow }, o); } catch { return; /* token without NEP-145 */ }
  if (reg) return;
  const bounds = await viewCall<{ min?: string } | null>(o.token, "storage_balance_bounds", {}, o).catch(() => null);
  await payer.call({
    contractId: o.token, methodName: "storage_deposit", args: { account_id: o.escrow, registration_only: true },
    deposit: BigInt(bounds?.min ?? "1250000000000000000000"), gas: 30n * 10n ** 12n,
  });
}

/** A PayError (or anything) in words a buyer can act on. */
export function payErrorText(e: unknown): string {
  const code = e instanceof PayError ? e.code : classify(e, false).code;
  const m = errText(e);
  switch (code) {
    case "not_enough_balance": return "Your wallet doesn't have enough for this.";
    case "rejected": return "The payment was cancelled in the wallet.";
    case "network": return "Couldn't reach NEAR just now. Check your connection and try again.";
    case "refused": return m;
    default: return m.length > 160 ? `${m.slice(0, 160)}…` : m;
  }
}
