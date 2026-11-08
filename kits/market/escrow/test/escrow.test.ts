import { afterEach, describe, expect, it, vi } from "vitest";
import { EscrowClient, EscrowError, newOrderId, orderMsg, orderStage, parseOrder, rpcView, type Signer, type View } from "../src/index.js";

const ESCROW = "escrow.test.near";
const TOKEN = "usdc.test.near";

function order(over: Record<string, unknown> = {}) {
  return {
    order_id: "o-1", buyer_id: "buyer.near", seller: "seller.near", seller_id: "seller.near", payout_id: "seller.near",
    token_id: TOKEN, amount: "5000000", status: "Held", created_at: "1", delivered_at: null, proof_id: null,
    revisions_used: 0, release_after_ns: "172800000000000", deliver_by: "604800000000001", fee_bps: 0, ...over,
  };
}

/** An in-memory stand-in for the escrow + token contracts. */
function fakeChain(o: { registered?: boolean } = {}) {
  const orders = new Map<string, Record<string, unknown>>();
  let registered = o.registered ?? true;
  const calls: { signer: string; contractId: string; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }[] = [];
  const views: string[] = [];
  const view: View = async (contractId, method, args) => {
    views.push(`${contractId}.${method}`);
    if (contractId === ESCROW && method === "get_order") return orders.get(String(args.order_id)) ?? null;
    if (contractId === ESCROW && method === "get_params") {
      return { release_after_ns: "1", delivery_deadline_ns: "2", max_revisions: 1, accepted_tokens: [TOKEN], fee_bps: 0,
        fee_account_id: "fee.near", min_amount: "1", registry_id: null, proof_log_id: null };
    }
    if (contractId === TOKEN && method === "storage_balance_of") return registered ? { total: "1250000000000000000000", available: "0" } : null;
    if (contractId === TOKEN && method === "storage_balance_bounds") return { min: "1250000000000000000000", max: "1250000000000000000000" };
    throw new Error(`unexpected view ${contractId}.${method}`);
  };
  const signer = (accountId: string, behave?: (c: (typeof calls)[number]) => unknown): Signer => ({
    accountId,
    call: async (p) => {
      const c = { signer: accountId, ...p };
      calls.push(c);
      if (behave) return behave(c);
      if (p.methodName === "storage_deposit") { registered = true; return { total: String(p.deposit), available: "0" }; }
      if (p.methodName === "ft_transfer_call") {
        const msg = JSON.parse(String(p.args.msg)) as { order_id: string; seller: string };
        if (orders.has(msg.order_id)) return "0";
        orders.set(msg.order_id, order({ order_id: msg.order_id, buyer_id: accountId, seller: msg.seller, amount: p.args.amount }));
        return p.args.amount;
      }
      return true;
    },
  });
  return { orders, calls, views, view, signer };
}

describe("pay", () => {
  it("sends ft_transfer_call with the order msg, 1 yoctoNEAR and the escrow as receiver", async () => {
    const f = fakeChain();
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, retryDelayMs: 1 }).as(f.signer("buyer.near"));
    const r = await escrow.pay({ orderId: "o-1", seller: "seller.near", token: TOKEN, amount: "5000000" });
    expect(r).toMatchObject({ paid: true, alreadyPaid: false, used: "5000000" });
    expect(r.order?.status).toBe("Held");
    const c = f.calls.find((c) => c.methodName === "ft_transfer_call")!;
    expect(c.contractId).toBe(TOKEN);
    expect(c.deposit).toBe(1n);
    expect(c.args).toEqual({ receiver_id: ESCROW, amount: "5000000", msg: orderMsg("o-1", "seller.near") });
    expect(JSON.parse(String(c.args.msg))).toEqual({ order_id: "o-1", seller: "seller.near" });
  });

  it("is idempotent: an order already on chain for this buyer is not paid again", async () => {
    const f = fakeChain();
    f.orders.set("o-1", order());
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("buyer.near") });
    const r = await escrow.pay({ orderId: "o-1", seller: "seller.near", token: TOKEN, amount: "5000000" });
    expect(r).toMatchObject({ paid: true, alreadyPaid: true });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses an order id another buyer already used", async () => {
    const f = fakeChain();
    f.orders.set("o-1", order({ buyer_id: "someone.near" }));
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("buyer.near") });
    await expect(escrow.pay({ orderId: "o-1", seller: "s.near", token: TOKEN, amount: "1" })).rejects.toThrow(/another buyer/);
  });

  it("reports a returned payment (used = 0) as not paid", async () => {
    const f = fakeChain();
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("buyer.near", () => "0") });
    expect(await escrow.pay({ orderId: "o-2", seller: "s.near", token: TOKEN, amount: "1" })).toMatchObject({ paid: false, used: "0", order: null });
  });

  it("checks the escrow's storage on the token; registers it only with ensureStorage", async () => {
    const f = fakeChain({ registered: false });
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("buyer.near"), retryDelayMs: 1 });
    await expect(escrow.pay({ orderId: "o-1", seller: "s.near", token: TOKEN, amount: "5" })).rejects.toThrow(/not registered/);
    expect(f.calls).toHaveLength(0);
    await escrow.pay({ orderId: "o-1", seller: "s.near", token: TOKEN, amount: "5", ensureStorage: true });
    expect(f.calls.map((c) => c.methodName)).toEqual(["storage_deposit", "ft_transfer_call"]);
    expect(f.calls[0]!.deposit).toBe(1250000000000000000000n);
    expect(f.calls[0]!.args).toEqual({ account_id: ESCROW, registration_only: true });
  });

  it("after a send timeout, finds the order on chain instead of failing", async () => {
    const f = fakeChain();
    const buyer = f.signer("buyer.near", (c) => {
      // The transaction lands, but the answer never comes back.
      const msg = JSON.parse(String(c.args.msg)) as { order_id: string };
      f.orders.set(msg.order_id, order({ order_id: msg.order_id }));
      return new Promise(() => {});
    });
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: buyer, txTimeoutMs: 20 });
    const r = await escrow.pay({ orderId: "o-1", seller: "seller.near", token: TOKEN, amount: "5000000" });
    expect(r).toMatchObject({ paid: true, used: "5000000" });
  });

  it("a failed send with nothing on chain surfaces the contract's panic message", async () => {
    const f = fakeChain();
    const buyer = f.signer("buyer.near", () => { throw new Error('{"kind":{"ExecutionError":"Smart contract panicked: The account doesn\'t have enough balance"}}'); });
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: buyer, retries: 0 });
    const err = await escrow.pay({ orderId: "o-9", seller: "s.near", token: TOKEN, amount: "5" }).catch((e) => e);
    expect(err).toBeInstanceOf(EscrowError);
    expect(err.message).toBe("ft_transfer_call failed: The account doesn't have enough balance");
  });

  it("validates input before touching the chain (amounts are U128 strings)", async () => {
    const f = fakeChain();
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("buyer.near") });
    for (const amount of ["1.5", "-1", "0", "", "1e6", 5 as unknown as string]) {
      await expect(escrow.pay({ orderId: "o", seller: "s.near", token: TOKEN, amount })).rejects.toThrow(/amount/);
    }
    await expect(escrow.pay({ orderId: "", seller: "s.near", token: TOKEN, amount: "1" })).rejects.toThrow(/orderId/);
    await expect(escrow.pay({ orderId: "x".repeat(129), seller: "s.near", token: TOKEN, amount: "1" })).rejects.toThrow(/orderId/);
    expect(f.views).toHaveLength(0);
  });

  it("needs a signer", async () => {
    const f = fakeChain();
    await expect(new EscrowClient({ contractId: ESCROW, view: f.view }).accept("o-1")).rejects.toThrow(/no signer/);
  });
});

describe("order actions", () => {
  it("call the right methods with the right args and gas", async () => {
    const f = fakeChain();
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view });
    const seller = escrow.as(f.signer("seller.near"));
    const buyer = escrow.as(f.signer("buyer.near"));
    const anyone = escrow.as(f.signer("bot.near"));
    await seller.markDelivered("o-1");
    await seller.markDelivered("o-1", "42");
    await buyer.accept("o-1");
    await buyer.requestRevision("o-1");
    await buyer.requestRefund("o-1");
    await seller.approveRefund("o-1");
    await seller.declineRefund("o-1");
    await anyone.releaseExpired("o-1");
    await anyone.refundUndelivered("o-1");
    expect(f.calls.map((c) => [c.signer, c.methodName, c.args])).toEqual([
      ["seller.near", "mark_delivered", { order_id: "o-1", proof_id: null }],
      ["seller.near", "mark_delivered", { order_id: "o-1", proof_id: "42" }],
      ["buyer.near", "accept", { order_id: "o-1" }],
      ["buyer.near", "request_revision", { order_id: "o-1" }],
      ["buyer.near", "request_refund", { order_id: "o-1" }],
      ["seller.near", "approve_refund", { order_id: "o-1" }],
      ["seller.near", "decline_refund", { order_id: "o-1" }],
      ["bot.near", "release_expired", { order_id: "o-1" }],
      ["bot.near", "refund_undelivered", { order_id: "o-1" }],
    ]);
    expect(f.calls.every((c) => c.contractId === ESCROW && c.deposit === 0n && c.gas >= 30n * 10n ** 12n)).toBe(true);
  });

  it("report false when the contract returns false (proof rejected, payout failed)", async () => {
    const f = fakeChain();
    const seller = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("seller.near", () => false) });
    expect(await seller.markDelivered("o-1", "7")).toBe(false);
  });

  it("are not retried: a failure surfaces once", async () => {
    const f = fakeChain();
    const seller = new EscrowClient({ contractId: ESCROW, view: f.view, signer: f.signer("x.near", () => { throw new Error("Smart contract panicked: seller only"); }) });
    await expect(seller.markDelivered("o-1")).rejects.toThrow("mark_delivered failed: seller only");
    expect(f.calls).toHaveLength(1);
  });
});

describe("reads", () => {
  it("getOrder / getParams validate what the chain returns", async () => {
    const f = fakeChain();
    f.orders.set("o-1", order());
    const escrow = new EscrowClient({ contractId: ESCROW, view: f.view });
    expect((await escrow.getOrder("o-1"))?.amount).toBe("5000000");
    expect(await escrow.getOrder("missing")).toBeNull();
    expect((await escrow.getParams()).accepted_tokens).toEqual([TOKEN]);
    expect(() => parseOrder({ ...order(), status: "Stolen" })).toThrow(/unknown status/);
    expect(() => parseOrder({ ...order(), amount: 5000000 })).toThrow(/amount/);
    expect(() => parseOrder("nope")).toThrow(EscrowError);
  });

  it("retry with backoff on transient failures, then give up", async () => {
    let n = 0;
    const flaky: View = async () => { if (++n < 3) throw new Error("503"); return order(); };
    expect((await new EscrowClient({ contractId: ESCROW, view: flaky, retryDelayMs: 1 }).getOrder("o-1"))?.order_id).toBe("o-1");
    expect(n).toBe(3);
    let m = 0;
    const down: View = async () => { m++; throw new Error("down"); };
    await expect(new EscrowClient({ contractId: ESCROW, view: down, retries: 2, retryDelayMs: 1 }).getOrder("o-1")).rejects.toThrow("down");
    expect(m).toBe(3);
  });

  it("time out a hanging read", async () => {
    const hang: View = () => new Promise(() => {});
    await expect(new EscrowClient({ contractId: ESCROW, view: hang, timeoutMs: 10, retries: 0 }).getOrder("o-1")).rejects.toThrow(/timed out/);
  });
});

describe("rpcView (near-api-js over a fake JSON-RPC)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("decodes a call_function result", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: unknown; params: Record<string, string> };
      expect(req.params).toMatchObject({ request_type: "call_function", account_id: ESCROW, method_name: "get_order" });
      expect(JSON.parse(Buffer.from(req.params.args_base64!, "base64").toString())).toEqual({ order_id: "o-1" });
      const result = [...Buffer.from(JSON.stringify(order()))];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { result, logs: [], block_height: 1, block_hash: "x" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = rpcView({ rpcUrls: ["http://rpc.invalid"], retries: 0 });
    const escrow = new EscrowClient({ contractId: ESCROW, view });
    expect((await escrow.getOrder("o-1"))?.status).toBe("Held");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("orderStage", () => {
  it("words for the seller and the buyer", () => {
    expect(orderStage("Held")).toMatchObject({ label: "New", tone: "act" });
    expect(orderStage("Held", "buyer")).toMatchObject({ label: "Paid", tone: "wait" });
    expect(orderStage("Delivered", "buyer").tone).toBe("act");
    expect(orderStage("RefundRequested")).toMatchObject({ label: "Refund requested", tone: "act" });
    expect(orderStage("Disputed").tone).toBe("bad");
    expect(orderStage("Releasing")).toMatchObject({ label: "Paying out…", busy: true });
    expect(orderStage("Released")).toMatchObject({ label: "Paid out", tone: "done" });
    expect(orderStage("Refunded", "buyer").tone).toBe("done");
    expect(orderStage(null).label).toBe("Unknown");
  });
});

it("newOrderId makes unique, valid ids", () => {
  const a = newOrderId(), b = newOrderId("shop");
  expect(a).not.toBe(b);
  expect(a).toMatch(/^ord_[0-9a-f-]{36}$/);
  expect(b.startsWith("shop_")).toBe(true);
});
