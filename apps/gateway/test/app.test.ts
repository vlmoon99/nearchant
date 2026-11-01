import { describe, expect, it, vi } from "vitest";
import type { HandleRecord, OrderStatus, PaymentRail } from "@nearchant/near";
import { createApp, type Deps } from "../src/app.js";
import { MemoryStore } from "@nearchant/db";
import type { GatewayConfig } from "../src/config.js";

const config: GatewayConfig = {
  profile: "demo", network: "testnet", public_url: "https://nearchant.com", base_domains: ["nearchant.com", "localhost"],
  dashboard_origin: "https://app.nearchant.com", rpc_urls: [], listen: { host: "127.0.0.1", port: 0 },
  token: { symbol: "nUSD", decimals: 6, test: true },
};

const alice: HandleRecord = {
  handle: "alice", owner_id: "alice.nearchant.testnet", account_id: "alice.nearchant.testnet", payout_account_id: "alice.nearchant.testnet",
  payout_token_id: null, card: { name: "Alice Decks", bio: "Pitch decks in an hour", avatar_hash: null, links: ["https://alice.example"] },
  gateway_url: null, embed_origins: ["https://alice.example"], status: "Active", created_at: "0", card_published_at: null,
};

async function setup(chain: Record<string, OrderStatus | null> = {}) {
  const store = new MemoryStore();
  await store.upsertService({ id: "deck", handle: "alice", title: "Pitch deck in 1 hour", description: "10 slides", priceUnits: "5000000", deliveryHours: 1, active: true });
  const rail: PaymentRail = {
    id: "fake",
    instruction: (o) => ({ rail: "fake", receiverId: "nusd", methodName: "ft_transfer_call", args: { o }, depositYocto: "1", gasTgas: 150 }),
    status: async (id) => chain[id] ?? null,
  };
  const onPaid = vi.fn(async () => {});
  const deps: Deps = {
    config, store, rail, onPaid, client: { rpcUrl: "https://rpc", orders: "orders.nearchant.testnet", network: "testnet" },
    handles: { get: async (h) => (h === "alice" ? alice : null) },
    newOrderId: () => "o-test-1",
    anyChainQuote: async () => ({ originAsset: "sol-usdc", amountIn: "5056676", amountInFormatted: "5.056676", amountOut: "5000000", label: "USDC on Solana" }),
  };
  return { app: createApp(deps), store, chain, onPaid };
}

const host = (h: string, extra: Record<string, string> = {}) => ({ headers: { host: h, ...extra } });

describe("seller card", () => {
  it("renders the card for <handle>.<base> and /h/<handle>", async () => {
    const { app } = await setup();
    for (const [url, init] of [["http://x/", host("alice.nearchant.com")], ["http://x/h/alice", host("localhost:8787")], ["http://x/h/alice/", host("localhost:8787")]] as const) {
      const res = await app.request(url, init);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Alice Decks");
      expect(html).toContain("5 nUSD");
      expect(html).toContain("TEST network");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' https://rpc");
    }
  });

  it("shows a 404 card for unknown handles and redirects the bare domain", async () => {
    const { app } = await setup();
    expect((await app.request("http://x/", host("bob.nearchant.com"))).status).toBe(404);
    expect((await app.request("http://x/", host("shop.alice.nearchant.com"))).status).toBe(302);
    expect((await app.request("http://x/", host("nearchant.com"))).headers.get("location")).toBe("https://app.nearchant.com");
  });
});

describe("A2A agent card", () => {
  it("lists the seller's services as skills", async () => {
    const { app } = await setup();
    const card = await (await app.request("http://x/.well-known/agent-card.json", host("alice.nearchant.com"))).json() as any;
    expect(card.name).toBe("Alice Decks");
    expect(card.url).toBe("https://alice.nearchant.com/a2a/v1");
    expect(card.skills[0].id).toBe("deck");
    expect(card["x-nearchant"].account_id).toBe("alice.nearchant.testnet");
  });
});

describe("A2A + escrow payment (flow 3)", () => {
  const rpc = (app: any, taskId: string, payment?: string) => app.request("http://x/a2a/v1", {
    method: "POST",
    headers: { host: "alice.nearchant.com", "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: taskId, parts: [{ kind: "text", text: "check these claims" }] } } }),
  });
  const pay = (id: string) => Buffer.from(JSON.stringify({ scheme: "nearchant-escrow", payment_id: id })).toString("base64");

  it("asks for payment, verifies it on chain, serves once", async () => {
    const { app, store } = await setup();
    await store.upsertService({ id: "fc", handle: "alice", title: "Fact-check", description: "d", priceUnits: "500000", deliveryHours: 1, active: true, agentEnv: "fact-checker" });
    const used = new Set<string>();
    const payments: Record<string, any> = {
      "1": { status: "Paid", payee_id: "alice.nearchant.testnet", amount: "500000", memo: "t-1" },
      "2": { status: "Pending", payee_id: "alice.nearchant.testnet", amount: "500000", memo: "t-2" },
      "3": { status: "Paid", payee_id: "bob.nearchant.testnet", amount: "500000", memo: "t-3" },
    };
    (app as any).__deps = null;
    const app2 = (await import("../src/app.js")).createApp({
      config, store, client: { rpcUrl: "https://rpc", orders: "o", network: "testnet" },
      rail: { id: "fake", instruction: () => ({}) as any, status: async () => null },
      handles: { get: async (h) => (h === "alice" ? alice : null) },
      a2a: {
        network: "testnet", asset: "nusd.nearchant.testnet",
        getPayment: async (id) => payments[id] ?? null,
        claim: async (r) => (used.has(r.paymentId) ? false : (used.add(r.paymentId), true)),
        execute: async (_h, s, text) => `checked by ${s.agentEnv}: ${text}`,
      },
    });
    const r402 = await rpc(app2, "t-1");
    expect(r402.status).toBe(402);
    const terms = (await r402.json() as any).accepts[0];
    expect(terms).toMatchObject({ scheme: "nearchant-escrow", amount: "500000", payTo: "alice.nearchant.testnet", network: "near:testnet" });

    const ok = await rpc(app2, "t-1", pay("1"));
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).result.artifacts[0].parts[0].text).toContain("checked by fact-checker");
    expect((await rpc(app2, "t-1", pay("1"))).status).toBe(409);      // replay
    expect((await rpc(app2, "t-2", pay("2"))).status).toBe(402);      // not settled
    expect((await rpc(app2, "t-3", pay("3"))).status).toBe(402);      // paid to someone else
    expect((await rpc(app2, "t-9", pay("1"))).status).toBe(402);      // memo is another task
  });
});

describe("CORS on /public/*", () => {
  it("reflects only allowlisted origins, never *", async () => {
    const { app } = await setup();
    const ok = await app.request("http://x/public/catalog", host("alice.nearchant.com", { origin: "https://alice.example" }));
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://alice.example");
    expect(ok.headers.get("vary")).toContain("Origin");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const bad = await app.request("http://x/public/catalog", host("alice.nearchant.com", { origin: "https://evil.example" }));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight (with Private Network Access) for allowed origins only", async () => {
    const { app } = await setup();
    const pre = (origin: string) => app.request("http://x/public/orders", { method: "OPTIONS", headers: {
      host: "alice.nearchant.com", origin, "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
    const ok = await pre("https://alice.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-private-network")).toBe("true");
    expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
    expect((await pre("https://evil.example")).status).toBe(403);
  });
});

describe("orders", () => {
  const order = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("http://x/public/orders", { method: "POST", headers: { host: "alice.nearchant.com", "content-type": "application/json" }, body: JSON.stringify(body) });

  it("validates input", async () => {
    const { app } = await setup();
    expect((await order(app, {})).status).toBe(400);
    expect((await order(app, { serviceId: "deck", brief: "short" })).status).toBe(400);
    expect((await order(app, { serviceId: "nope", brief: "A deck for my coffee startup" })).status).toBe(404);
  });

  it("creates an order with the payment instruction and an any-chain quote", async () => {
    const { app, store } = await setup();
    const res = await order(app, { serviceId: "deck", brief: "A deck for my coffee startup, 10 slides" });
    expect(res.status).toBe(201);
    const j = await res.json() as any;
    expect(j.orderId).toBe("o-test-1");
    expect(j.payment.methodName).toBe("ft_transfer_call");
    expect(j.anyChainQuote.amountInFormatted).toBe("5.056676");
    expect((await store.getOrder("o-test-1"))?.state).toBe("awaiting_payment");
  });

  it("marks paid only after the chain shows the right order, once", async () => {
    const { app, store, chain, onPaid } = await setup();
    await order(app, { serviceId: "deck", brief: "A deck for my coffee startup, 10 slides" });
    const status = async () => (await (await app.request("http://x/public/orders/o-test-1", host("alice.nearchant.com"))).json()) as any;

    expect((await status()).state).toBe("awaiting_payment"); // not on chain yet
    chain["o-test-1"] = { status: "Held", amount: "1", buyer_id: "b", seller_handle: "alice" }; // wrong amount
    expect((await status()).state).toBe("awaiting_payment");
    chain["o-test-1"] = { status: "Held", amount: "5000000", buyer_id: "b", seller_handle: "alice" };
    expect((await status()).state).toBe("paid");
    await status();
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect((await store.getOrder("o-test-1"))?.state).toBe("paid");
    // Another handle can't read the order.
    expect((await app.request("http://x/public/orders/o-test-1", host("bob.nearchant.com"))).status).toBe(404);
  });
});
