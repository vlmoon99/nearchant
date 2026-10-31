import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { handleFromHost, type HandleRecord, type PaymentRail, type DryQuote } from "@nearchant/near";
import { formatUnits, type GatewayConfig } from "./config.js";
import { originOf, publicCors } from "./cors.js";
import { CARD_JS, CardPage, NotFoundPage, SITE_CSS } from "./pages.js";
import type { Store } from "./store.js";

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
}

type Env = { Variables: { handle: HandleRecord | null; handleName: string | null } };

const MAX_BRIEF = 4000;

export function createApp(d: Deps) {
  const app = new Hono<Env>();
  const price = (u: string) => `${formatUnits(u, d.config.token.decimals)} ${d.config.token.symbol}`;
  const newOrderId = d.newOrderId ?? (() => `o-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);

  app.use("*", secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:", "https:"], frameAncestors: ["'none'"] },
    crossOriginResourcePolicy: false,
  }));

  app.get("/health", (c) => c.json({ ok: true, profile: d.config.profile, network: d.config.network }));
  app.get("/assets/site.css", (c) => c.body(SITE_CSS, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/card.js", (c) => c.body(CARD_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }));

  // Seller resolution: `<handle>.<base domain>` or `/h/<handle>/…` (local dev and tunnels without a wildcard).
  // The Host header is only a lookup key; the `handles` contract record decides (CLAUDE.md).
  const resolve = async (c: Context<Env>, name: string | null) => {
    c.set("handleName", name);
    c.set("handle", name ? await d.handles.get(name) : null);
  };

  const seller = new Hono<Env>();

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
    if (!c.get("handleName")) return c.redirect(d.config.dashboard_origin, 302);
    if (!h) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const services = await d.store.listServices(h.handle);
    const base = c.req.path.startsWith("/h/") ? `/h/${h.handle}/` : "/";
    return c.html(<CardPage handle={h} services={services} price={price} testToken={d.config.token.test} base={base} />);
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

  seller.post("/public/orders", async (c) => {
    const h = c.get("handle");
    if (!h) return c.json({ error: "unknown handle" }, 404);
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
