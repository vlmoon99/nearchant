import { createHash } from "node:crypto";

/**
 * Flow 3 client (docs/swarm.md "Hiring another agent"): A2A SendMessage → 402 terms → escrow.pay → retry with
 * X-PAYMENT. Pure orchestration; the chain call and HTTP are injected so tests can fake them.
 */
export interface PaymentTerms {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  resource: string;
}

export interface HireDeps {
  fetch: typeof fetch;
  /** escrow.pay signed by the hiring seller's escrow key; returns the payment record. */
  pay: (payTo: string, amount: string, memo: string) => Promise<{ payment_id: string; status: string }>;
  /** escrow.get_payment (to wait for an owner approval). */
  paymentStatus: (paymentId: string) => Promise<string | null>;
  /** Refuse terms above this many base units. */
  maxAmount: bigint;
  log?: (m: string) => void;
}

export interface HireResult {
  text: string;
  paymentId: string;
  amount: string;
  payTo: string;
  taskId: string;
}

async function rpc(d: HireDeps, url: string, taskId: string, text: string, payment?: string) {
  return d.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0", id: taskId, method: "SendMessage",
      params: { message: { role: "user", messageId: taskId, parts: [{ kind: "text", text }] } },
    }),
    signal: AbortSignal.timeout(240_000),
  });
}

/** The payment memo binds the task text, so a payment can't be redeemed for a different prompt (security review M2). */
export function taskMemo(taskId: string, text: string): string {
  return `${taskId}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export async function hireAgent(d: HireDeps, a2aUrl: string, taskId: string, text: string): Promise<HireResult> {
  const first = await rpc(d, a2aUrl, taskId, text);
  if (first.status !== 402) throw new Error(`expected 402 payment terms, got ${first.status}`);
  const offer = (await first.json()) as { accepts?: PaymentTerms[] };
  const terms = offer.accepts?.find((t) => t.scheme === "nearchant-escrow");
  if (!terms) throw new Error("seller offers no nearchant-escrow terms");
  if (BigInt(terms.amount) > d.maxAmount) throw new Error(`price ${terms.amount} above limit ${d.maxAmount}`);

  const p = await d.pay(terms.payTo, terms.amount, taskMemo(taskId, text));
  d.log?.(`hire: escrow payment ${p.payment_id} → ${terms.payTo} (${terms.amount}) is ${p.status}`);
  let status = p.status;
  for (let i = 0; i < 20 && status !== "Paid"; i++) {
    if (status === "Rejected" || status === "Failed") throw new Error(`payment ${p.payment_id} ${status}`);
    if (status === "Pending") throw new Error(`payment ${p.payment_id} waits for the owner's approval`);
    await new Promise((r) => setTimeout(r, 1500));
    status = (await d.paymentStatus(p.payment_id)) ?? status;
  }
  if (status !== "Paid") throw new Error(`payment ${p.payment_id} not settled (${status})`);

  const proof = Buffer.from(JSON.stringify({ scheme: terms.scheme, network: terms.network, payment_id: p.payment_id })).toString("base64");
  const second = await rpc(d, a2aUrl, taskId, text, proof);
  const body = (await second.json()) as { result?: { artifacts?: { parts?: { kind: string; text?: string }[] }[] }; error?: { message: string } };
  if (!second.ok || body.error) throw new Error(`seller refused after payment: ${body.error?.message ?? second.status}`);
  const out = body.result?.artifacts?.[0]?.parts?.find((x) => x.kind === "text")?.text;
  if (!out) throw new Error("no text artifact in the result");
  return { text: out, paymentId: p.payment_id, amount: terms.amount, payTo: terms.payTo, taskId };
}
