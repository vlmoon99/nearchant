import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { handleFromHost, type HandleRecord, type PaymentRail, type DryQuote } from "@nearchant/near";
import { formatUnits, type GatewayConfig } from "./config.js";
import { originOf, publicCors } from "./cors.js";
import { CardPage, NotFoundPage, OrderPage, SITE_CSS, type ClientConfig, type OrderView } from "./pages.js";
import { RateLimit } from "./buyers.js";
import type { Store } from "@nearchant/db";

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
  sponsorBuyer?: (publicKey: string) => Promise<{ accountId: string; created?: boolean }>;
  /** Job progress + files of an order (from the artifacts table). */
  progress?: (orderId: string) => Promise<{ stepsDone: string[]; files: { kind: string; url: string }[]; stopped: string | null }>;
}

type Env = { Variables: { handle: HandleRecord | null; handleName: string | null } };

const MAX_BRIEF = 4000;

export function createApp(d: Deps) {
  const app = new Hono<Env>();
  const price = (u: string) => `${formatUnits(u, d.config.token.decimals)} ${d.config.token.symbol}`;
  const newOrderId = d.newOrderId ?? (() => `o-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);

  const pageHeaders = secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:", "https:"], frameAncestors: ["'none'"] },
    crossOriginResourcePolicy: false,
  });
  // Media files set their own headers (sandboxed HTML); everything else gets the page policy.
  app.use("*", (c, next) => (c.req.path.startsWith("/media/") ? next() : pageHeaders(c, next)));

  // Deliverables. M0: an unguessable order id is the capability; files exist only after delivery.
  app.get("/media/:order/:file", async (c) => {
    const { order, file } = c.req.param();
    if (!d.mediaDir || !/^[A-Za-z0-9._-]+$/.test(order) || !/^[A-Za-z0-9_-]+\.(pdf|pptx|html|png|md)$/.test(file)) return c.notFound();
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
    return c.html(<CardPage handle={h} services={services} price={price} testToken={d.config.token.test} base={base} cfg={d.client} />);
  });

  const buyerLimit = new RateLimit(5, 3_600_000);
  seller.post("/public/buyers", async (c) => {
    if (!d.sponsorBuyer) return c.json({ error: "buyer sponsorship is off" }, 404);
    const body = (await c.req.json().catch(() => null)) as { publicKey?: unknown } | null;
    if (typeof body?.publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.publicKey)) return c.json({ error: "publicKey must be an ed25519 key" }, 400);
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    // Re-asking for an account that exists is free; only new sponsorships count against the limit.
    const r = await d.sponsorBuyer(body.publicKey).catch((e: Error) => ({ error: e.message }));
    if ("error" in r) return c.json({ error: r.error }, 502);
    if ((r as { created?: boolean }).created && !buyerLimit.take(ip)) return c.json({ error: "too many new test wallets from this address; try later" }, 429);
    return c.json(r);
  });

  seller.get("/o/:id", async (c) => {
    const h = c.get("handle");
    const row = await d.store.getOrder(c.req.param("id"));
    if (!h || !row || row.handle !== h.handle) return c.html(<NotFoundPage testToken={d.config.token.test} />, 404);
    const chain = await d.rail.status(row.orderId).catch(() => undefined);
    if (chain && row.state === "awaiting_payment" && chain.status !== "Opening" && chain.amount === row.amount && chain.seller_handle === h.handle) {
      if (await d.store.transitionOrder(row.orderId, "awaiting_payment", "paid")) { row.state = "paid"; await d.onPaid?.(row.orderId); }
    }
    const service = await d.store.getService(h.handle, row.serviceId);
    const p = (await d.progress?.(row.orderId)) ?? { stepsDone: [], files: [], stopped: null };
    const o: OrderView = {
      orderId: row.orderId, handle: h, serviceTitle: service?.title ?? "Order", amountDisplay: price(row.amount), state: row.state,
      chainStatus: chain?.status ?? null, revisionsLeft: ((chain as { revisions_used?: number } | undefined)?.revisions_used ?? 0) < 1,
      stepsDone: p.stepsDone, files: p.files, stopped: p.stopped,
    };
    const base = c.req.path.startsWith("/h/") ? `/h/${h.handle}/` : "/";
    return c.html(<OrderPage o={o} base={base} cfg={d.client} testToken={d.config.token.test} />);
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
