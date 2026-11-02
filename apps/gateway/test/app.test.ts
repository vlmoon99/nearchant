import { describe, expect, it, vi } from "vitest";
import type { HandleRecord, OrderStatus, PaymentRail } from "@nearchant/near";
import { createApp, type Deps } from "../src/app.js";
import { MemoryStore } from "@nearchant/db";
import { taskMemo } from "@nearchant/swarm";
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

describe("store feed", () => {
  it("shows a store's posts, a public post page with proof, item and link preview, and counts the post's view", async () => {
    const base = await setup();
    const views: unknown[] = [];
    const post = { id: "p1", itemId: "i-1", publishedAt: "2026-11-01T15:00:00Z", hashtags: ["denim"], caption: "Raw denim, up close.", img: "/files/alice/public/p1.webp?w=640", video: "/files/alice/public/p1.mp4", proofId: "21" };
    const sf = { handle: "alice", name: "Alice Wear", account: "alice.nearchant.testnet", summary: "", orders: 0,
      items: [{ id: "i-1", title: "Dark denim jacket", description: "", price: "40 nUSD", img: null, kind: "product", options: [] }],
      posts: [post, ...Array.from({ length: 9 }, (_, k) => ({ ...post, id: `q${k}`, itemId: null, video: null, caption: `Post ${k}` }))] };
    const app = createApp({ ...(base as unknown as { app: unknown }), config, store: base.store, rail: { id: "fake", instruction: () => ({}) as never, status: async () => null }, onPaid: async () => {},
      client: { rpcUrl: "https://rpc", orders: "orders.nearchant.testnet", network: "testnet" }, handles: { get: async (h) => (h === "alice" ? alice : null) },
      similar: async () => [{ id: "x1", handle: "bob", storeName: "Bob Denim", caption: "Selvedge jeans", img: "/files/bob/public/x1.png?w=640", video: false }, { id: "x2", handle: "alice", storeName: "Alice Wear", caption: "own post", img: "/f.png", video: false }],
      storefront: async (_h, view) => { views.push(view); return view?.postId && !sf.posts.some((p) => p.id === view.postId) ? { ...sf, posts: [] } : sf; } } as Deps);
    const store = await (await app.request("http://x/h/alice/", host("nearchant.com"))).text();
    expect(store).toContain('data-follow="alice"');
    expect(store).toContain('href="/h/alice/p/p1"');
    expect(store).toContain("All 10 posts");
    const page = await app.request("http://x/h/alice/p/p1?ref=instagram", host("nearchant.com"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Raw denim, up close.");
    expect(html).toContain('href="https://nearchant.com/verify/21"');
    expect(html).toContain('href="/h/alice/i/i-1"'); // Buy the item the post shows
    expect(html).toContain('property="og:image" content="https://nearchant.com/files/alice/public/p1.webp?w=1024"');
    expect(html).toContain("<video");
    expect(html).toContain("More like this on Nearchant");
    expect(html).toContain('href="https://nearchant.com/h/bob/p/x1?ref=similar"');
    expect(html).not.toContain("own post"); // the store's own posts are under "More from", not here
    expect(html).toContain('data-report-post="p1"');
    expect(views.at(-1)).toEqual({ source: "instagram", postId: "p1" });
    expect((await app.request("http://x/h/alice/p/nope", host("nearchant.com"))).status).toBe(404);
    expect((await app.request("http://x/h/alice/p/..%2Fx", host("nearchant.com"))).status).toBe(404);
    const all = await (await app.request("http://x/h/alice/posts", host("nearchant.com"))).text();
    expect(all.match(/class="post"/g)).toHaveLength(10);
    // On the store's own subdomain the links stay relative and the preview points at that host.
    const sub = await (await app.request("http://x/p/p1", host("alice.nearchant.com"))).text();
    expect(sub).toContain('content="https://alice.nearchant.com/p/p1"');
  });
});

describe("home page", () => {
  it("serves the landing at the bare domain when one is configured, a store page on a store host", async () => {
    const { store } = await setup();
    const { LandingPage } = await import("../src/ui/landing.js");
    const cfg = { base: "/", rpcUrl: "https://rpc", network: "testnet", token: "nUSD", decimals: 6, storeBase: "nearchant.com" };
    const app = createApp({
      config, store, rail: { id: "fake", instruction: () => ({}) as never, status: async () => null }, onPaid: async () => {}, client: { rpcUrl: "https://rpc", orders: "orders.nearchant.testnet", network: "testnet" },
      handles: { get: async (h) => (h === "alice" ? alice : null) },
      landing: async () => LandingPage({ cfg, test: true, d: { posts: [], stats: { proofs: 18, paidOrders: 6, stores: 4 }, verifyHref: null, limits: { free: { posts: 12, images: 12 }, pro: { posts: 150, images: 300 } } } }),
    });
    const home = await app.request("http://x/", host("nearchant.com"));
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Posts that sell.");
    expect(html).toContain("18 posts");           // real counts, not the mockup's
    expect(html.match(/Example · your post here/g)).toHaveLength(3); // no real posts → three labelled examples
    expect(html).not.toContain("See a verified post"); // no verified post yet → no button
    expect((await app.request("http://x/", host("alice.nearchant.com"))).status).toBe(200);
  });
});

describe("landing firstLine", () => {
  it("keeps the first sentence and cuts long ones at a word", async () => {
    const { firstLine } = await import("../src/ui/landing.js");
    expect(firstLine("Soft linen. Made in Kyiv.")).toBe("Soft linen.");
    expect(firstLine("Cold mornings in Kyiv call for something that holds its shape and keeps you warm")).toBe("Cold mornings in Kyiv call for something that holds its…");
  });
});

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
    const results = new Map<string, string>();
    const payments: Record<string, any> = {
      "1": { status: "Paid", payee_id: "alice.nearchant.testnet", amount: "500000", memo: taskMemo("t-1", "check these claims") },
      "2": { status: "Pending", payee_id: "alice.nearchant.testnet", amount: "500000", memo: taskMemo("t-2", "check these claims") },
      "3": { status: "Paid", payee_id: "bob.nearchant.testnet", amount: "500000", memo: taskMemo("t-3", "check these claims") },
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
        cached: async (id) => results.get(id) ?? null,
        save: async (id, out) => { results.set(id, out); },
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
    const again = await rpc(app2, "t-1", pay("1"));                     // same paid task again: cached result, no new work
    expect(again.status).toBe(200);
    expect((await again.json() as any).result.artifacts[0].parts[0].text).toContain("checked by fact-checker");
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

describe("A2A memo binds the text", () => {
  it("a front-runner with a different prompt is refused", async () => {
    expect(taskMemo("t-1", "check these claims")).not.toBe(taskMemo("t-1", "write my essay"));
  });
});
