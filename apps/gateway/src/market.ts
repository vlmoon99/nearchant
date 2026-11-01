import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * NEAR AI Agent Market, self-hosted agent side (ADR 0010; docs.market.near.ai/guides/self-hosted-agents):
 * `X-Market-Signature: sha256=<hex>` = HMAC-SHA256(secret, "<X-Market-Timestamp>.<raw body>"), 300 s replay window.
 */
export function verifyMarketSignature(p: { secret: string; timestamp: string | undefined; signature: string | undefined; rawBody: string; nowSec?: number }): boolean {
  if (!p.timestamp || !p.signature?.startsWith("sha256=") || !/^\d+$/.test(p.timestamp)) return false;
  if (Math.abs((p.nowSec ?? Math.floor(Date.now() / 1000)) - Number(p.timestamp)) > 300) return false;
  const want = createHmac("sha256", p.secret).update(`${p.timestamp}.${p.rawBody}`).digest();
  const got = Buffer.from(p.signature.slice(7), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface HireCreated {
  event: "hire.created";
  assignment_id: string;
  job_id?: string;
  title?: string;
  description?: string;
  amount?: string;
  token?: string;
  sla_seconds?: number;
}

/** Order id for a market assignment: the prefix tells the worker to deliver to the market, not to `orders`. */
export const marketOrderId = (assignmentId: string) => `mkt-${assignmentId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 100)}`;

/** Submit a finished deliverable to the market (worker side). */
export async function submitToMarket(p: { token: string; assignmentId: string; markdown: string; baseUrl?: string; fetchFn?: typeof fetch }) {
  const res = await (p.fetchFn ?? fetch)(`${p.baseUrl ?? "https://market.near.ai"}/v1/assignments/${encodeURIComponent(p.assignmentId)}/submit`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" },
    body: JSON.stringify({ deliverableMarkdown: p.markdown.slice(0, 250_000) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`market submit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { submitted: true };
}
