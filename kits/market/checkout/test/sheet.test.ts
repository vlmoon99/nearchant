// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { PaySheet, payWithSheet, type FunctionCall, type PaidState } from "../src/index.js";

afterEach(() => { document.body.innerHTML = ""; });
const steps = () => [...document.querySelectorAll(".ncpay-steps li")].map((li) => `${li.textContent}:${li.className}`);
const title = () => document.querySelector(".ncpay-title")!.textContent;
const buttons = () => [...document.querySelectorAll<HTMLElement>(".ncpay-btn")];

describe("PaySheet", () => {
  it("shows the three steps and follows step events", () => {
    const s = new PaySheet({ subtitle: "5 USDC to Alice" }).open();
    expect(steps()).toEqual(["Preparing wallet:todo", "Paying:todo", "Confirming on NEAR:todo"]);
    expect(document.querySelector<HTMLElement>(".ncpay-x")!.hidden).toBe(true); // can't close while paying
    s.step({ step: "pay", state: "now" });
    expect(steps()).toEqual(["Preparing wallet:done", "Paying:now", "Confirming on NEAR:todo"]);
    s.paid();
    expect(title()).toBe("Paid ✓");
    expect(steps().every((x) => x.endsWith(":done"))).toBe(true);
    buttons()[0]!.click();
    expect(document.querySelector(".ncpay-back")).toBeNull();
  });

  it("failed() shows the reason and Try again", () => {
    let retried = 0;
    const s = new PaySheet().open();
    s.step({ step: "confirm", state: "now" });
    s.failed({ text: "Nope", retry: () => { retried++; } });
    expect(title()).toBe("Payment didn't go through");
    expect(steps().at(-1)).toBe("Confirming on NEAR:bad");
    expect(buttons().map((b) => b.textContent)).toEqual(["Try again", "Close"]);
    buttons()[0]!.click();
    expect(retried).toBe(1);
  });

  it("escapes text (textContent, never HTML)", () => {
    new PaySheet({ subtitle: "<img src=x onerror=alert(1)>" }).open();
    expect(document.querySelector(".ncpay-text img")).toBeNull();
  });
});

describe("payWithSheet", () => {
  const base = () => {
    const sent: FunctionCall[] = [];
    let state: PaidState = "missing";
    return {
      sent,
      opts: {
        token: "t.near", escrow: "e.near", amount: "10", orderId: "o-2", checkBalance: false, registerEscrow: false,
        sleep: async () => {}, pollMs: 0,
        checkPaid: async () => state,
        payer: { accountId: "b.near", call: async (c: FunctionCall) => { sent.push(c); state = "paid"; return "10"; } },
      },
    };
  };

  it("ends on Paid ✓ with the caller's buttons", async () => {
    const b = base();
    const r = await payWithSheet({ ...b.opts, paid: (x) => ({ text: `Order ${x.orderId}`, buttons: [{ label: "Open my order", primary: true, href: "/o/o-2" }] }) });
    expect(r?.status).toBe("paid");
    expect(title()).toBe("Paid ✓");
    expect(document.querySelector(".ncpay-text")!.textContent).toBe("Order o-2");
    expect(buttons()[0]!.getAttribute("href")).toBe("/o/o-2");
  });

  it("Try again after a failure pays once and resolves", async () => {
    const b = base();
    let fail = true;
    const payer = { accountId: "b.near", call: async (c: FunctionCall) => { if (fail) { fail = false; throw new Error("User rejected"); } return b.opts.payer.call(c); } };
    const p = payWithSheet({ ...b.opts, payer });
    await new Promise((r) => setTimeout(r, 10));
    expect(title()).toBe("Payment didn't go through");
    expect(document.querySelector(".ncpay-text")!.textContent).toMatch(/cancelled[\s\S]*No money left/);
    buttons()[0]!.click();
    const r = await p;
    expect(r?.status).toBe("paid");
    expect(b.sent).toHaveLength(1);
  });

  it("resolves null when the buyer closes after a failure", async () => {
    const b = base();
    const p = payWithSheet({ ...b.opts, payer: { accountId: "b.near", call: async () => { throw new Error("boom"); } } });
    await new Promise((r) => setTimeout(r, 10));
    buttons()[1]!.click();
    await expect(p).resolves.toBeNull();
  });
});
