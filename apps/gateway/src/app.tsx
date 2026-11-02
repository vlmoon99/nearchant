import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { ItemOrderPage, ItemPage, StorePage, PostsPage, PublicPostPage } from "./ui/store.js";
import { secureHeaders } from "hono/secure-headers";
import { handleFromHost, type HandleRecord, type PaymentRail, type DryQuote } from "@nearchant/near";
import { formatUnits, type GatewayConfig } from "./config.js";
import { originOf, publicCors } from "./cors.js";
import { CardPage, ManagePage, NewShopPage, NotFoundPage, OrderPage, SITE_CSS, type ClientConfig, type OrderView, type ShopStats } from "./pages.js";
import { RateLimit, RateLimited, clientIp } from "./buyers.js";
import { verifyMarketSignature, type HireCreated } from "./market.js";
import { bodyHash, newWebhookSecret, secretMatches, validBotToken, verifySellerSignature, type TgUpdate } from "./telegram.js";
import type { Service, Store } from "@nearchant/db";
import { taskMemo } from "@nearchant/swarm";

export interface Deps {
  config: GatewayConfig;
  handles: { get(handle: string): Promise<HandleRecord | null> };
  store: Store;
  rail: PaymentRail;
  /** Best-effort "pay from another chain" quote for display (null = hide). */
  anyChainQuote?: (amountUnits: string) => Promise<(DryQuote & { label: string }) | null>;
  newOrderId?: () => string;
  /** Called once an order is confirmed paid on chain (enqueues the swarm job). */
  onPaid?: (orderId: string) => Promise<void>;
  /** Rendered decks and images, served at /media/<orderId>/<file>. */
  mediaDir?: string;
  /** Bundled web/checkout.ts. */
  checkoutJs?: string;
  client: ClientConfig;
  /** Testnet: create + fund the implicit account of a browser key (ADR 0001). */
  sponsorBuyer?: (publicKey: string, allowNew: () => boolean) => Promise<{ accountId: string; created?: boolean }>;
  /** "Create your shop in 60 s" (testnet, sponsored): claims the handle and adds the default deck service. */
  createShop?: (s: { handle: string; ownerPublicKey: string; name: string; bio: string; priceUnits: string }) => Promise<{ accountId: string }>;
  isAvailable?: (handle: string) => Promise<boolean>;
  /** Seller dashboard numbers read from chain (balances, billing, hiring campaign). */
  stats?: (accountId: string, handle: string) => Promise<ShopStats>;
  /** Per-seller Telegram bots (ADR 0011). */
  telegram?: {
    isOwnerKey: (accountId: string, publicKey: string) => Promise<boolean>;
    connect: (handle: string, token: string, webhookUrl: string, secret: string) => Promise<{ username: string }>;
    secretFor: (handle: string) => Promise<string | null>;
    onUpdate: (handle: string, update: TgUpdate) => Promise<void>;
  };
  /** NEAR AI Agent Market (ADR 0010): sealed per-seller market token + webhook secret. */
  market?: {
    connect: (handle: string, token: string, webhookSecret: string) => Promise<void>;
    secretFor: (handle: string) => Promise<string | null>;
    onHire: (handle: string, hire: HireCreated) => Promise<void>;
  };
  /** Flow 3 seller side: A2A tasks paid through escrow (docs/swarm.md). */
  a2a?: {
    network: string;
    asset: string;
    getPayment: (paymentId: string) => Promise<{ status: string; payee_id: string; amount: string; memo: string } | null>;
    claim: (row: { paymentId: string; handle: string; taskId: string; amount: string }) => Promise<boolean>;
    cached: (paymentId: string) => Promise<string | null>;
    save: (paymentId: string, result: string) => Promise<void>;
    execute: (handle: HandleRecord, service: Service, text: string, paymentId: string) => Promise<string>;
  };
  /** Store the buyer's "what to change" note for a revision (read by the write step). */
  saveRevisionNote?: (orderId: string, note: string) => Promise<void>;
  /** Content stores (ADR 0018): the buyer storefront data, or null for a classic card. */
  /** nearchant.com home page (no store in the host): rendered landing; unset → redirect to the dashboard. */
  landing?: () => Promise<unknown>;
  storefront?: (handle: string, view?: { source: string | null; itemId?: string; postId?: string }) => Promise<import("./ui/store.js").StoreData | null>;
  /** Job progress + files of an order (from the artifacts table). */
  progress?: (orderId: string) => Promise<{ stepsDone: string[]; files: { kind: string; url: string }[]; stopped: string | null }>;
}

type Env = { Variables: { handle: HandleRecord | null; handleName: string | null } };

const MAX_BRIEF = 4000;

export function createApp(d: Deps) {
  const app = new Hono<Env>({ strict: false });
  const ipOf = (c: Context<Env>) => clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress);
  const price = (u: string) => `${formatUnits(u, d.config.token.decimals)} ${d.config.token.symbol}`;
  // The order id is the capability for its deliverables, so it must be unguessable (security review H3).
  const newOrderId = d.newOrderId ?? (() => `o-${crypto.randomUUID()}`);

  const pageHeaders = secureHeaders({
    // Scripts only from this site. connect/frame: NEAR RPCs plus the wallets of NEAR Wallet Selector (ADR 0022: HOT,
    // HERE, Intear, NEAR Mobile, Bitte talk to their own bridges over https/wss and may open a frame).
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:", "https:"], frameAncestors: ["'none'"],
      connectSrc: ["'self'", ...new Set([d.client.rpcUrl, ...d.config.rpc_urls].map((u) => new URL(u).origin)), "https:", "wss:"],
      frameSrc: ["'self'", "https:"],
    },
    crossOriginResourcePolicy: false,
  });
  // Media files set their own headers (sandboxed HTML); everything else gets the page policy.
  app.use("*", (c, next) => (c.req.path.startsWith("/media/") ? next() : pageHeaders(c, next)));

  // Deliverables. M0: an unguessable order id is the capability; files exist only after delivery.
  app.get("/media/:order/:file", async (c) => {
    const { order, file } = c.req.param();
    if (!d.mediaDir || !/^[A-Za-z0-9_-]+$/.test(order) || !/^[A-Za-z0-9_-]+\.(pdf|pptx|html|png|md)$/.test(file)) return c.notFound();
    try {
      const bytes = await readFile(join(d.mediaDir, order, file));
      const ext = file.split(".").pop()!;
      const types: Record<string, string> = {
        pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        html: "text/html; charset=utf-8", png: "image/png", md: "text/markdown; charset=utf-8",
      };
      const headers: Record<string, string> = { "content-type": types[ext]!, "x-content-type-options": "nosniff" };
      // Marp HTML carries inline scripts/styles: sandbox it so it can't act on this origin.
      if (ext === "html") headers["content-security-policy"] = "sandbox allow-scripts; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";
      if (ext === "pdf" || ext === "pptx") headers["content-disposition"] = `attachment; filename="deck-${order}.${ext}"`;
      return c.body(bytes, 200, headers);
    } catch {
      return c.notFound();
    }
  });

  app.get("/health", (c) => c.json({ ok: true, profile: d.config.profile, network: d.config.network }));
  app.get("/assets/site.css", (c) => c.body(SITE_CSS, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/checkout.js", (c) => d.checkoutJs ? c.body(d.checkoutJs, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }) : c.notFound());

  // Seller resolution: `<handle>.<base domain>` or `/h/<handle>/…` (local dev and tunnels without a wildcard).
  // The Host header is only a lookup key; the `handles` contract record decides (CLAUDE.md).
  const resolve = async (c: Context<Env>, name: string | null) => {
    c.set("handleName", name);
    c.set("handle", name ? await d.handles.get(name) : null);
  };

  const seller = new Hono<Env>({ strict: false });

  seller.use("/public/*", publicCors(async (c) => {
    const h = c.get("handle");
    const s = new Set<string>([originOf(d.config.public_url)]);
    if (h) {
      for (const o of h.embed_origins) s.add(o);
      for (const base of d.config.base_domains) {
        if (base !== "localhost") s.add(`https://${h.handle}.${base}`);
      }
    }
    return s;
  }));

  seller.get("/", async (c) => {
    const h = c.get("handle");
    if (!c.get("handleName")) return d.landing ? c.html((await d.landing()) as string) : c.redirect(d.config.dashboard_origin, 302);
    if (!h) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const base = c.req.path.startsWith("/h/") ? `/h/${h.handle}/` : "/";
    // A visit is counted for analytics; ?ref=telegram (from share links) says where it came from.
    const ref = (c.req.query("ref") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20) || null;
    const sf = d.storefront ? await d.storefront(h.handle, { source: ref }).catch(() => null) : null;
    if (sf) return c.html(<StorePage s={sf} cfg={{ base, rpcUrl: d.client.rpcUrl, orders: d.client.orders, network: d.client.network }} test={d.config.token.test} />);
    const services = await d.store.listServices(h.handle);
    return c.html(<CardPage handle={h} services={services} price={price} testToken={d.config.token.test} base={base} cfg={d.client} />);
  });

  const refOf = (c: Context) => (c.req.query("ref") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20) || null;
  /** Absolute address of a store's pages (path stores on the main host, or the store's own subdomain). */
  const storeOrigin = (c: Context, handle: string) => (c.req.path.startsWith("/h/") ? `${d.config.public_url}/h/${handle}/` : `https://${handle}.${d.config.base_domains[0]}/`);
  const cfgOf = (c: Context, handle: string) => ({ base: c.req.path.startsWith("/h/") ? `/h/${handle}/` : "/", rpcUrl: d.client.rpcUrl, orders: d.client.orders, network: d.client.network });

  // The store's own feed: buyers follow it here; Instagram/Telegram links bring people in.
  seller.get("/posts", async (c) => {
    const h = c.get("handle");
    if (!h || !d.storefront) return c.notFound();
    const sf = await d.storefront(h.handle, { source: refOf(c) }).catch(() => null);
    if (!sf) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    return c.html(<PostsPage s={sf} cfg={cfgOf(c, h.handle)} test={d.config.token.test} />);
  });

  seller.get("/p/:id", async (c) => {
    const h = c.get("handle");
    const id = c.req.param("id");
    if (!h || !d.storefront || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.notFound();
    const sf = await d.storefront(h.handle, { source: refOf(c), postId: id }).catch(() => null);
    const p = sf?.posts.find((x) => x.id === id);
    if (!sf || !p) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const origin = storeOrigin(c, h.handle), url = `${origin}p/${p.id}`;
    const abs = (u: string | null) => (u ? new URL(u, origin).toString() : null);
    return c.html(<PublicPostPage s={sf} p={p} cfg={cfgOf(c, h.handle)} test={d.config.token.test} url={url}
      verifyUrl={p.proofId ? `${d.config.public_url}/verify/${p.proofId}` : null}
      og={{ title: `${sf.name} on Nearchant`, description: p.caption.slice(0, 200), url, image: abs(p.img?.replace(/\?w=\d+/, "?w=1024") ?? null) }} />);
  });

  seller.get("/i/:id", async (c) => {
    const h = c.get("handle");
    if (!h || !d.storefront) return c.notFound();
    const sf = await d.storefront(h.handle, { source: (c.req.query("ref") ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20) || null, itemId: c.req.param("id") }).catch(() => null);
    const item = sf?.items.find((i) => i.id === c.req.param("id"));
    if (!sf || !item) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const base = c.req.path.startsWith("/h/") ? `/h/${h.handle}/` : "/";
    return c.html(<ItemPage s={sf} i={item} cfg={{ base, rpcUrl: d.client.rpcUrl, orders: d.client.orders, network: d.client.network }} test={d.config.token.test} />);
  });

  const buyerLimit = new RateLimit(5, 3_600_000);
  const buyerDaily = new RateLimit(300, 86_400_000);
  seller.post("/public/buyers", async (c) => {
    if (!d.sponsorBuyer) return c.json({ error: "buyer sponsorship is off" }, 404);
    const body = (await c.req.json().catch(() => null)) as { publicKey?: unknown } | null;
    if (typeof body?.publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.publicKey)) return c.json({ error: "publicKey must be an ed25519 key" }, 400);
    const ip = ipOf(c);
    // Re-asking for an account that exists is free; a new wallet must pass the per-IP and daily limits first.
    try {
      return c.json(await d.sponsorBuyer(body.publicKey, () => buyerDaily.take("all") && buyerLimit.take(ip)));
    } catch (e) {
      if (e instanceof RateLimited) return c.json({ error: e.message }, 429);
      return c.json({ error: (e as Error).message.slice(0, 200) }, 502);
    }
  });

  seller.get("/manage", async (c) => {
    const h = c.get("handle");
    if (!h) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    // Private numbers and order ids load only after the seller signs (security review H3).
    return c.html(<ManagePage handle={h} cfg={d.client} testToken={d.config.token.test} />);
  });

  const noteLimit = new RateLimit(20, 3_600_000);
  seller.post("/public/orders/:id/revision-note", async (c) => {
    const h = c.get("handle");
    const row = await d.store.getOrder(c.req.param("id"));
    if (!h || !row || row.handle !== h.handle || !d.saveRevisionNote) return c.json({ error: "unknown order" }, 404);
    if (!noteLimit.take(ipOf(c))) return c.json({ error: "too many requests" }, 429);
    const chain = await d.rail.status(row.orderId).catch(() => null);
    if (chain?.status !== "Delivered") return c.json({ error: "revisions can be requested only for a delivered order" }, 409);
    const b = (await c.req.json().catch(() => null)) as { note?: unknown } | null;
    const note = typeof b?.note === "string" ? b.note.trim().slice(0, 1000) : "";
    if (note.length < 3) return c.json({ error: "say briefly what to change" }, 400);
    await d.saveRevisionNote(row.orderId, note);
    return c.json({ saved: true });
  });

  seller.get("/o/:id", async (c) => {
    const h = c.get("handle");
    const row = await d.store.getOrder(c.req.param("id"));
    if (!h || !row || row.handle !== h.handle) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const chain = await d.rail.status(row.orderId).catch(() => undefined);
    if (chain && row.state === "awaiting_payment" && chain.status !== "Opening" && chain.amount === row.amount && chain.seller_handle === h.handle) {
      if (await d.store.transitionOrder(row.orderId, "awaiting_payment", "paid")) { row.state = "paid"; await d.onPaid?.(row.orderId); }
    }
    if (chain?.status === "Released" && row.state === "delivered" && (await d.store.transitionOrder(row.orderId, "delivered", "released"))) row.state = "released";
    if (chain?.status === "Refunded" && row.state === "delivered" && (await d.store.transitionOrder(row.orderId, "delivered", "refunded"))) row.state = "refunded";
    const service = await d.store.getService(h.handle, row.serviceId);
    const p = (await d.progress?.(row.orderId)) ?? { stepsDone: [], files: [], stopped: null };
    const o: OrderView = {
      orderId: row.orderId, handle: h, serviceTitle: service?.title ?? "Order", amountDisplay: price(row.amount), state: row.state,
      chainStatus: chain?.status ?? null, revisionsLeft: ((chain as { revisions_used?: number } | undefined)?.revisions_used ?? 0) < 1,
      stepsDone: p.stepsDone, files: p.files, stopped: p.stopped, item: row.serviceId.startsWith("i-"),
    };
    const base = c.req.path.startsWith("/h/") ? `/h/${h.handle}/` : "/";
    const sf = o.item && d.storefront ? await d.storefront(h.handle).catch(() => null) : null;
    if (sf) return c.html(<ItemOrderPage s={sf} cfg={{ base, rpcUrl: d.client.rpcUrl, orders: d.client.orders, network: d.client.network }} test={d.config.token.test} o={{ orderId: o.orderId, title: o.serviceTitle, amount: o.amountDisplay, chainStatus: o.chainStatus }} />);
    return c.html(<OrderPage o={o} base={base} cfg={d.client} testToken={d.config.token.test} />);
  });

  // A2A agent card (ADR 0010): lets other agents and the NEAR AI Agent Market discover what this seller's agent does.
  seller.get("/.well-known/agent-card.json", async (c) => {
    const h = c.get("handle");
    if (!h) return c.json({ error: "unknown handle" }, 404);
    const services = await d.store.listServices(h.handle);
    const origin = c.req.path.startsWith("/h/") ? `${d.config.public_url}/h/${h.handle}` : `https://${h.handle}.${d.config.base_domains[0]}`;
    c.header("access-control-allow-origin", "*"); // public metadata, no credentials
    return c.json({
      protocolVersion: "0.3.0",
      name: h.card.name,
      description: h.card.bio || `${h.card.name} on Nearchant`,
      url: `${origin}/a2a/v1`,
      version: "0.1.0",
      provider: { organization: "Nearchant", url: "https://nearchant.com" },
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/markdown", "application/pdf"],
      skills: services.map((s) => ({
        id: s.id, name: s.title, description: s.description, tags: ["pitch-deck", "presentation"],
        examples: ["Seed deck for a coffee subscription startup raising 300k EUR"],
      })),
      "x-nearchant": {
        account_id: h.account_id,
        network: d.config.network,
        payment: { token: d.config.token.symbol, test: d.config.token.test, rail: d.rail.id },
        prices: Object.fromEntries(services.map((s) => [s.id, s.priceUnits])),
      },
    });
  });

  // A2A endpoint (JSON-RPC SendMessage) with x402-style payment through escrow-policy (flow 3).
  seller.post("/a2a/v1", async (c) => {
    const h = c.get("handle");
    const rpcErr = (id: unknown, code: number, message: string, status: 400 | 402 | 404 | 409 | 502 = 400) => c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
    if (!h || !d.a2a) return rpcErr(null, -32601, "no A2A agent here", 404);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; method?: string; params?: { message?: { messageId?: string; parts?: { kind?: string; text?: string }[] } } } | null;
    if (!body || !["SendMessage", "message/send"].includes(body.method ?? "")) return rpcErr(body?.id, -32601, "method not supported");
    const taskId = body.params?.message?.messageId ?? "";
    const text = (body.params?.message?.parts ?? []).filter((p) => p.kind === "text" && p.text).map((p) => p.text).join("\n");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId) || !text || text.length > 20_000) return rpcErr(body.id, -32602, "message needs a messageId and text (max 20k chars)");
    const service = (await d.store.listServices(h.handle)).find((s) => s.agentEnv);
    if (!service) return rpcErr(body.id, -32601, "this seller sells no A2A service", 404);

    const header = c.req.header("x-payment");
    if (!header) {
      return c.json({
        x402Version: 1,
        error: "payment required",
        accepts: [{ scheme: "nearchant-escrow", network: `near:${d.a2a.network}`, asset: d.a2a.asset, amount: service.priceUnits, payTo: h.account_id, resource: new URL(c.req.url).pathname }],
      }, 402);
    }
    let paymentId: string;
    try {
      paymentId = String((JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payment_id?: unknown }).payment_id ?? "");
    } catch {
      return rpcErr(body.id, -32602, "bad X-PAYMENT header", 402);
    }
    const p = await d.a2a.getPayment(paymentId).catch(() => null);
    if (!p || p.status !== "Paid" || p.payee_id !== h.account_id || BigInt(p.amount) < BigInt(service.priceUnits) || p.memo !== taskMemo(taskId, text)) {
      return rpcErr(body.id, -32001, "payment not found, not settled, not to this seller, too small, or for another task", 402);
    }
    const ok = (out: string) => c.json({ jsonrpc: "2.0", id: body.id ?? null, result: { kind: "task", id: taskId, status: { state: "completed" }, artifacts: [{ artifactId: `${taskId}:result`, parts: [{ kind: "text", text: out }] }] } });
    if (!(await d.a2a.claim({ paymentId, handle: h.handle, taskId, amount: p.amount }))) {
      // Same payment, same text (the memo matched): serve the stored result again, or say it's still running.
      const prev = await d.a2a.cached(paymentId);
      return prev ? ok(prev) : rpcErr(body.id, -32002, "this paid task is already running", 409);
    }
    try {
      const out = await d.a2a.execute(h, service, text, paymentId);
      await d.a2a.save(paymentId, out);
      return ok(out);
    } catch (e) {
      return rpcErr(body.id, -32003, `task failed: ${(e as Error).message.slice(0, 200)}`, 502);
    }
  });

  seller.get("/public/catalog", async (c) => {
    const h = c.get("handle");
    if (!h) return c.json({ error: "unknown handle" }, 404);
    const services = await d.store.listServices(h.handle);
    return c.json({
      handle: h.handle,
      accountId: h.account_id,
      card: h.card,
      token: d.config.token,
      services: services.map((s) => ({ ...s, priceDisplay: price(s.priceUnits) })),
    });
  });

  const orderLimit = new RateLimit(30, 3_600_000);
  seller.post("/public/orders", async (c) => {
    const h = c.get("handle");
    if (!h) return c.json({ error: "unknown handle" }, 404);
    if (!orderLimit.take(ipOf(c))) return c.json({ error: "too many orders from this address; try later" }, 429);
    const body = await c.req.json().catch(() => null) as { serviceId?: unknown; brief?: unknown; buyerAccountId?: unknown } | null;
    if (!body || typeof body.serviceId !== "string" || typeof body.brief !== "string") {
      return c.json({ error: "serviceId and brief are required" }, 400);
    }
    const brief = body.brief.trim();
    if (brief.length < 10 || brief.length > MAX_BRIEF) return c.json({ error: `brief must be 10–${MAX_BRIEF} characters` }, 400);
    const service = await d.store.getService(h.handle, body.serviceId);
    if (!service?.active) return c.json({ error: "unknown service" }, 404);
    const buyer = typeof body.buyerAccountId === "string" && /^[a-z0-9._-]{2,64}$/.test(body.buyerAccountId) ? body.buyerAccountId : null;

    const orderId = newOrderId();
    const now = new Date().toISOString();
    await d.store.createOrder({ orderId, handle: h.handle, serviceId: service.id, amount: service.priceUnits, brief, buyerAccountId: buyer, state: "awaiting_payment", createdAt: now, updatedAt: now });
    const payment = d.rail.instruction({ orderId, sellerHandle: h.handle, amount: service.priceUnits });
    const anyChainQuote = d.anyChainQuote ? await d.anyChainQuote(service.priceUnits).catch(() => null) : null;
    return c.json({ orderId, amount: service.priceUnits, amountDisplay: price(service.priceUnits), payment, anyChainQuote }, 201);
  });

  seller.get("/public/orders/:id", async (c) => {
    const h = c.get("handle");
    const id = c.req.param("id");
    const row = await d.store.getOrder(id);
    if (!h || !row || row.handle !== h.handle) return c.json({ error: "unknown order" }, 404);
    // Confirm on chain before marking paid (architecture §9). The contract is the truth for money state.
    const chain = await d.rail.status(id).catch(() => undefined);
    if (chain && row.state === "awaiting_payment" && chain.status !== "Opening" && chain.seller_handle === h.handle && chain.amount === row.amount) {
      if (await d.store.transitionOrder(id, "awaiting_payment", "paid")) {
        row.state = "paid";
        await d.onPaid?.(id);
      }
    }
    return c.json({ orderId: id, state: row.state, chainStatus: chain?.status ?? (chain === null ? "not_found" : "unknown"), amountDisplay: price(row.amount) });
  });

  // "Create your shop" lives on the platform host (not a seller subdomain).
  const shopLimit = new RateLimit(3, 3_600_000);
  const shopDaily = new RateLimit(50, 86_400_000);
  app.get("/new", (c) => (c.get("handleName") ? c.notFound() : c.html(<NewShopPage cfg={d.client} testToken={d.config.token.test} enabled={!!d.createShop} />)));
  app.get("/api/handles/:name", async (c) => c.json({ available: d.isAvailable ? await d.isAvailable(c.req.param("name")).catch(() => false) : false }));
  app.post("/api/shops", async (c) => {
    if (!d.createShop) return c.json({ error: "shop creation is off on this gateway" }, 404);
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = String(b?.handle ?? ""), name = String(b?.name ?? "").trim(), bio = String(b?.bio ?? "").trim();
    const ownerPublicKey = String(b?.ownerPublicKey ?? "");
    const price = Number(b?.price ?? 5);
    if (!/^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){0,30}[a-z0-9]$/.test(handle)) return c.json({ error: "handle: 2–32 of a-z 0-9 - _" }, 400);
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(ownerPublicKey)) return c.json({ error: "ownerPublicKey must be an ed25519 key" }, 400);
    if (name.length < 2 || name.length > 80 || bio.length > 600) return c.json({ error: "name 2–80 chars, bio up to 600" }, 400);
    if (!(price >= 0.5 && price <= 100)) return c.json({ error: "price must be 0.5–100 nUSD" }, 400);
    if (!shopLimit.take(ipOf(c)) || !shopDaily.take("all")) return c.json({ error: "too many new shops from this address; try later" }, 429);
    try {
      const r = await d.createShop({ handle, ownerPublicKey, name, bio, priceUnits: String(Math.round(price * 10 ** d.config.token.decimals)) });
      return c.json({ ...r, cardUrl: `/h/${handle}/` }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message.slice(0, 200) }, 409);
    }
  });

  // Telegram: the seller connects their own bot (signed with their account key), Telegram calls the webhook.
  app.post("/api/shops/:handle/dashboard", async (c) => {
    const handle = c.req.param("handle");
    const h = await d.handles.get(handle);
    const b = (await c.req.json().catch(() => null)) as { message?: string; signature?: string; publicKey?: string } | null;
    if (!h || !b?.message || !b.signature || !b.publicKey || !d.telegram) return c.json({ error: "handle, message, signature and publicKey are required" }, 400);
    if (!verifySellerSignature({ message: b.message, signature: b.signature, publicKey: b.publicKey, handle, action: "dashboard" })) return c.json({ error: "bad or expired signature" }, 401);
    if (!(await d.telegram.isOwnerKey(h.account_id, b.publicKey))) return c.json({ error: "that key is not a full-access key of the shop account" }, 403);
    const stats = d.stats ? await d.stats(h.account_id, h.handle).catch(() => null) : null;
    const fmtStats = stats && {
      wallet: price(stats.wallet),
      billing: stats.billing && { balance: price(stats.billing.balance), spentToday: price(stats.billing.spent_today), spentMonth: price(stats.billing.spent_month) },
      campaign: stats.campaign && {
        left: price(String(BigInt(stats.campaign.budget) - BigInt(stats.campaign.spent) - BigInt(stats.campaign.reserved))),
        autoLimit: price(stats.campaign.policy.auto_limit), dailyLimit: price(stats.campaign.policy.daily_limit), allowlist: stats.campaign.policy.allowlist,
      },
    };
    const orders = (await d.store.listOrders(h.handle, 10)).map((o) => ({ id: o.orderId, state: o.state, amount: price(o.amount), at: o.createdAt.slice(0, 16).replace("T", " ") }));
    return c.json({ stats: fmtStats, orders });
  });

  app.post("/api/shops/:handle/telegram", async (c) => {
    if (!d.telegram) return c.json({ error: "telegram is off on this gateway" }, 404);
    const handle = c.req.param("handle");
    const h = await d.handles.get(handle);
    const b = (await c.req.json().catch(() => null)) as { token?: string; message?: string; signature?: string; publicKey?: string } | null;
    if (!h || !b?.token || !b.message || !b.signature || !b.publicKey) return c.json({ error: "handle, token, message, signature and publicKey are required" }, 400);
    if (!validBotToken(b.token)) return c.json({ error: "that doesn't look like a BotFather token" }, 400);
    if (!verifySellerSignature({ message: b.message, signature: b.signature, publicKey: b.publicKey, handle, action: "telegram", bodyHash: bodyHash(b.token) })) return c.json({ error: "bad or expired signature" }, 401);
    if (!(await d.telegram.isOwnerKey(h.account_id, b.publicKey))) return c.json({ error: "that key is not a full-access key of the shop account" }, 403);
    try {
      const r = await d.telegram.connect(handle, b.token, `${d.config.public_url}/bots/telegram/${handle}`, newWebhookSecret());
      return c.json({ connected: true, bot: r.username });
    } catch (e) {
      return c.json({ error: (e as Error).message.slice(0, 200) }, 502);
    }
  });
  app.post("/bots/telegram/:handle", async (c) => {
    if (!d.telegram) return c.notFound();
    const handle = c.req.param("handle");
    const secret = await d.telegram.secretFor(handle);
    if (!secret || !secretMatches(secret, c.req.header("x-telegram-bot-api-secret-token"))) return c.body(null, 401);
    const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
    if (update) void d.telegram.onUpdate(handle, update).catch((e) => console.warn(`[telegram] ${handle}: ${(e as Error).message}`));
    return c.body(null, 200); // answer fast; Telegram retries slow webhooks
  });

  // NEAR AI Agent Market: connect (signed by the shop key) and the hire webhook.
  app.post("/api/shops/:handle/market", async (c) => {
    if (!d.market || !d.telegram) return c.json({ error: "market integration is off on this gateway" }, 404);
    const handle = c.req.param("handle");
    const h = await d.handles.get(handle);
    const b = (await c.req.json().catch(() => null)) as { token?: string; webhookSecret?: string; message?: string; signature?: string; publicKey?: string } | null;
    if (!h || !b?.token?.startsWith("aat_") || !b.webhookSecret || b.webhookSecret.length < 32 || !b.message || !b.signature || !b.publicKey) {
      return c.json({ error: "need an aat_ token, a webhook secret of 32+ chars, and a signature" }, 400);
    }
    if (!verifySellerSignature({ message: b.message, signature: b.signature, publicKey: b.publicKey, handle, action: "market", bodyHash: bodyHash(b.token, b.webhookSecret) })) return c.json({ error: "bad or expired signature" }, 401);
    if (!(await d.telegram.isOwnerKey(h.account_id, b.publicKey))) return c.json({ error: "that key is not a full-access key of the shop account" }, 403);
    await d.market.connect(handle, b.token, b.webhookSecret);
    return c.json({ connected: true, webhookUrl: `${d.config.public_url}/market/webhook/${handle}` });
  });
  app.post("/market/webhook/:handle", async (c) => {
    if (!d.market) return c.notFound();
    const handle = c.req.param("handle");
    const secret = await d.market.secretFor(handle);
    const raw = await c.req.text();
    if (!secret || !verifyMarketSignature({ secret, timestamp: c.req.header("x-market-timestamp"), signature: c.req.header("x-market-signature"), rawBody: raw })) return c.body(null, 401);
    const event = c.req.header("x-market-event");
    if (event === "hire.created") {
      const hire = JSON.parse(raw) as HireCreated;
      if (!hire.assignment_id) return c.body(null, 400);
      await d.market.onHire(handle, hire); // idempotent by assignment id (same delivery retried → same order)
    }
    return c.body(null, 200); // a 2xx to hire.created counts as "started"
  });

  // Host-based seller routes, then the `/h/<handle>` form.
  app.use("*", async (c, next) => {
    const name = handleFromHost(c.req.header("host"), d.config.base_domains);
    if (name) await resolve(c, name);
    await next();
  });
  app.use("/h/:handle/*", async (c, next) => {
    await resolve(c, c.req.param("handle"));
    await next();
  });
  app.use("/h/:handle", async (c, next) => {
    await resolve(c, c.req.param("handle"));
    await next();
  });
  app.route("/h/:handle", seller);
  app.route("/", seller);

  return app;
}
