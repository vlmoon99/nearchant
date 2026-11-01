import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { marketOrderId, submitToMarket, verifyMarketSignature } from "../src/market.js";

const secret = "whsec_" + "x".repeat(32);
const sign = (ts: string, body: string) => "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

describe("agent market", () => {
  it("verifies signatures over timestamp.body within 300 s", () => {
    const body = JSON.stringify({ event: "hire.created", assignment_id: "a1" });
    const now = 1_800_000_000;
    const ts = String(now);
    expect(verifyMarketSignature({ secret, timestamp: ts, signature: sign(ts, body), rawBody: body, nowSec: now })).toBe(true);
    expect(verifyMarketSignature({ secret, timestamp: ts, signature: sign(ts, body), rawBody: body + " ", nowSec: now })).toBe(false);
    expect(verifyMarketSignature({ secret, timestamp: ts, signature: sign(ts, body), rawBody: body, nowSec: now + 301 })).toBe(false);
    expect(verifyMarketSignature({ secret: "other" + secret, timestamp: ts, signature: sign(ts, body), rawBody: body, nowSec: now })).toBe(false);
    expect(verifyMarketSignature({ secret, timestamp: ts, signature: undefined, rawBody: body, nowSec: now })).toBe(false);
  });

  it("maps assignments to safe order ids and submits markdown", async () => {
    expect(marketOrderId("4f1c-a2/../x")).toBe("mkt-4f1c-a2x");
    let sent: any;
    const fetchFn = (async (url: string, init: any) => { sent = { url, init }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await submitToMarket({ token: "aat_t", assignmentId: "a1", markdown: "# Deck", baseUrl: "https://m.test", fetchFn });
    expect(sent.url).toBe("https://m.test/v1/assignments/a1/submit");
    expect(JSON.parse(sent.init.body).deliverableMarkdown).toBe("# Deck");
    expect(sent.init.headers.authorization).toBe("Bearer aat_t");
  });
});
