import { describe, expect, it } from "vitest";
import { escrowMsg, fromWalletSelector, payErrorText, payWithEscrow, PayError, type FunctionCall, type PayOptions, type StepEvent } from "../src/index.js";
import { fakeRpc, type ViewFn } from "./fake-rpc.js";

const TOKEN = "usdc.test.near", ESCROW = "orders.test.near", BUYER = "buyer.test.near";

/** A world with a token, an escrow and a buyer. `orderStates` is what get_order returns on successive reads. */
function world(o: { balance?: string; registered?: boolean; orderStates?: (object | null)[]; result?: unknown; callError?: Error; extraViews?: Record<string, ViewFn> } = {}) {
  const sent: FunctionCall[] = [];
  const states = [...(o.orderStates ?? [null, { status: "Opening" }, { status: "Held", amount: "5000000", token_id: TOKEN }])];
  let reads = 0;
  const rpc = fakeRpc({
    [`${TOKEN}.ft_balance_of`]: () => o.balance ?? "9000000",
    [`${TOKEN}.storage_balance_of`]: () => (o.registered === false && !sent.some((c) => c.methodName === "storage_deposit") ? null : { total: "1", available: "0" }),
    [`${TOKEN}.storage_balance_bounds`]: () => ({ min: "2350000000000000000000", max: null }),
    // The first read is the "already paid?" check, before anything is sent.
    [`${ESCROW}.get_order`]: () => { const s = reads === 0 ? null : states[Math.min(reads - 1, states.length - 1)]; reads++; return s; },
    ...o.extraViews,
  });
  const payer = { accountId: BUYER, call: async (c: FunctionCall) => { sent.push(c); if (o.callError) throw o.callError; return c.methodName === "ft_transfer_call" ? o.result ?? "5000000" : undefined; } };
  let t = 0;
  const steps: StepEvent[] = [];
  const opts: PayOptions = {
    token: TOKEN, escrow: ESCROW, amount: "5000000", orderId: "o-1", seller: "alice.testnet", payer, fetch: rpc.fetch,
    onStep: (e) => steps.push(e), sleep: async (ms) => { t += ms; }, now: () => t, retries: 0,
  };
  return { opts, sent, steps, rpc };
}

describe("payWithEscrow", () => {
  it("pays with ft_transfer_call and waits until the escrow holds the order", async () => {
    const w = world();
    const r = await payWithEscrow(w.opts);
    expect(r).toEqual({ status: "paid", orderId: "o-1", buyer: BUYER, sent: true });
    expect(w.sent).toHaveLength(1);
    const c = w.sent[0]!;
    expect(c).toMatchObject({ contractId: TOKEN, methodName: "ft_transfer_call", deposit: 1n, gas: 100n * 10n ** 12n });
    expect(c.args).toEqual({ receiver_id: ESCROW, amount: "5000000", msg: '{"order_id":"o-1","seller":"alice.testnet"}' });
    expect(w.steps.map((s) => `${s.step}:${s.state}`)).toEqual(["wallet:now", "wallet:done", "pay:now", "pay:done", "confirm:now", "confirm:done"]);
    expect(w.rpc.calls.every((x) => x.finality === "optimistic")).toBe(true);
  });

  it("registers the escrow on the token first when it isn't", async () => {
    const w = world({ registered: false });
    await payWithEscrow(w.opts);
    expect(w.sent.map((c) => c.methodName)).toEqual(["storage_deposit", "ft_transfer_call"]);
    expect(w.sent[0]).toMatchObject({ args: { account_id: ESCROW, registration_only: true }, deposit: 2350000000000000000000n });
  });

  it("sends nothing when the order is already paid (retry-safe)", async () => {
    const w = world();
    const r = await payWithEscrow({ ...w.opts, checkPaid: async () => "paid" });
    expect(r.sent).toBe(false);
    expect(w.sent).toHaveLength(0);
  });

  it("stops before the wallet signs when the balance is short", async () => {
    const w = world({ balance: "100" });
    const e = await payWithEscrow(w.opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PayError);
    expect((e as PayError).code).toBe("not_enough_balance");
    expect(w.sent).toHaveLength(0);
    expect(w.steps.at(-1)).toMatchObject({ step: "wallet", state: "bad" });
    expect(payErrorText(e)).toMatch(/enough/);
  });

  it("uses a custom msg", async () => {
    const w = world();
    await payWithEscrow({ ...w.opts, msg: (id) => JSON.stringify({ order: id, memo: "x" }) });
    expect(w.sent[0]!.args.msg).toBe('{"order":"o-1","memo":"x"}');
    expect(escrowMsg("a")).toBe('{"order_id":"a"}');
  });

  it("calls the payer factory inside the wallet step", async () => {
    const w = world();
    let made = 0;
    const p = w.opts.payer as Exclude<PayOptions["payer"], () => unknown>;
    await payWithEscrow({ ...w.opts, payer: async () => { made++; return p; } });
    expect(made).toBe(1);
  });

  it("reports a refusal when ft_transfer_call kept nothing", async () => {
    const w = world({ result: "0" });
    await expect(payWithEscrow(w.opts)).rejects.toMatchObject({ code: "refused" });
  });

  it("reports a refusal when the order never appears", async () => {
    const w = world({ orderStates: [null] });
    await expect(payWithEscrow({ ...w.opts, missingGraceMs: 5000, pollMs: 1000 })).rejects.toMatchObject({ code: "refused" });
    expect(w.steps.at(-1)).toMatchObject({ step: "confirm", state: "bad" });
  });

  it("returns pending (not an error) when confirmation takes too long", async () => {
    const w = world({ orderStates: [{ status: "Opening" }] });
    const r = await payWithEscrow({ ...w.opts, confirmTimeoutMs: 10_000 });
    expect(r.status).toBe("pending");
  });

  it("flags a network failure while paying as maybe sent", async () => {
    const w = world({ callError: new Error("Failed to fetch") });
    const e = (await payWithEscrow(w.opts).catch((x: unknown) => x)) as PayError;
    expect(e.code).toBe("network");
    expect(e.maybeSent).toBe(true);
    expect(w.steps.at(-1)).toMatchObject({ step: "pay", state: "bad" });
  });

  it("maps a wallet rejection", async () => {
    const w = world({ callError: new Error("User rejected the request") });
    await expect(payWithEscrow(w.opts)).rejects.toMatchObject({ code: "rejected", maybeSent: false });
  });

  it("refuses when the order id holds a different payment", async () => {
    const w = world({ orderStates: [{ status: "Held", amount: "1", token_id: TOKEN }] });
    await expect(payWithEscrow(w.opts)).rejects.toMatchObject({ code: "refused" });
  });

  it("keeps waiting through RPC hiccups while confirming", async () => {
    const w = world();
    let n = 0;
    const r = await payWithEscrow({ ...w.opts, checkPaid: async () => { n++; if (n === 1) return "missing"; if (n < 4) throw new Error("503"); return "paid"; } });
    expect(r.status).toBe("paid");
  });

  it("rejects a bad amount", async () => {
    const w = world();
    await expect(payWithEscrow({ ...w.opts, amount: "1.5" })).rejects.toThrow(/integer/);
    await expect(payWithEscrow({ ...w.opts, amount: "0" })).rejects.toThrow(/integer/);
  });
});

describe("fromWalletSelector", () => {
  it("turns a call into a FunctionCall action", async () => {
    const seen: unknown[] = [];
    const p = fromWalletSelector({ signAndSendTransaction: async (x) => { seen.push(x); return {}; } }, "bob.testnet");
    await p.call({ contractId: TOKEN, methodName: "ft_transfer_call", args: { a: 1 }, deposit: 1n, gas: 30n });
    expect(seen[0]).toEqual({ signerId: "bob.testnet", receiverId: TOKEN, actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { a: 1 }, gas: "30", deposit: "1" } }] });
  });
});
