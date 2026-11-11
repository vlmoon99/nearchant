import { createHash } from "node:crypto";
import { Hono } from "hono";
// Gateway entry. env: DATABASE_URL (else in-memory), NEAR_RELAYER_KEY (buyer sponsorship), MEDIA_DIR, PUBLIC_URL, PORT.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { parse } from "yaml";
import { Artifacts, ContentStore, FeedStore, PLAN_LIMITS, Envelopes, Outbox, MemoryStore, PgStore, Sealer, a2aResult, claimA2aPayment, saveA2aResult, connect, createShop, getSecret, handlesWithSecret, putSecret, runMigrations, waitWhileFenced, type Connection, type Service, type Store } from "@nearchant/db";
import { sql } from "drizzle-orm";
import { TelegramApi, handleUpdate, type TgUpdate } from "./telegram.js";
import { marketOrderId, type HireCreated } from "./market.js";
import { formatUnits } from "./config.js";
import { Router } from "@nearchant/providers";
import { answerShopper, loadAgentEnv, makeAsker, planSearch, type AgentEnv } from "@nearchant/swarm";
import { Chain, HandleCache, TestnetDirectRail, loadAccounts, oneClickDryQuote } from "@nearchant/near";
import { contactLine, type Contact } from "./contact.js";
import { itemFacts, ships, soldOut, type ItemDetails } from "./item-details.js";
import { isBannerFormat, renderBanner } from "./banners.js";
import { createApp } from "./app.js";
import { mountSellerApp, readSession } from "./seller-app.js";
import { getCookie } from "hono/cookie";
import { mountModeration } from "./admin/moderation.js";
import { mountBuyerApp, type SearchIntent } from "./buyer-app.js";
import { emailHtml, resendMailer } from "./email.js";
import { LandingPage } from "./ui/landing.js";
import { assetV } from "./ui/kit.js";
import { mountUi } from "./ui/routes.js";
import { mountI18n, parseLangs } from "./i18n.js";
import { labApp } from "./admin/lab.js";
import { ComfyCloud, type LabVariant } from "@nearchant/providers";
import { RateLimit, sponsorBuyer } from "./buyers.js";
import { loadGatewayConfig } from "./config.js";

// Standby fence (ADR 0020): while the Mac standby serves the site, this node waits instead of using a stale database.
await waitWhileFenced(process.env.FENCE_URL);

const configDir = resolve(process.env.NEARCHANT_CONFIG_DIR ?? join(import.meta.dirname, "../../../config"));
const config = loadGatewayConfig(join(configDir, "gateway.yaml"), {
  ...(process.env.PUBLIC_URL ? { public_url: process.env.PUBLIC_URL } : {}),
  ...(process.env.PORT ? { listen: { host: "0.0.0.0", port: Number(process.env.PORT) } } : {}),
});
const accounts = loadAccounts(join(configDir, "defaults/accounts.yaml"), config.network);
const relayerKey = process.env.NEAR_RELAYER_KEY;
const chain = new Chain({ rpcUrls: config.rpc_urls, ...(relayerKey ? { relayer: { accountId: accounts.relayer, secretKey: relayerKey } } : {}) });
const handles = new HandleCache(chain.view, accounts.root);

let store: Store;
let queue: WorkerUtils | null = null;
let artifacts: Artifacts | null = null;
let conn: Connection | null = null;
if (process.env.DATABASE_URL) {
  conn = connect(process.env.DATABASE_URL);
  await runMigrations(conn.db, conn.sql);
  store = new PgStore(conn.db);
  artifacts = new Artifacts(conn.db);
  queue = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL });
  await queue.migrate();
} else {
  console.warn("[gateway] DATABASE_URL not set: in-memory store, no swarm queue (data is lost on restart)");
  store = new MemoryStore();
}
for (const s of (parse(readFileSync(join(configDir, "seed.yaml"), "utf8")) as { services: Service[] }).services) await store.upsertService(s);

// Mainnet asset ids for the display-only any-chain quote, looked up once.
let assets: { from: string; to: string } | null | undefined;
async function anyChainQuote(amountUnits: string) {
  if (assets === undefined) {
    try {
      const tokens = (await (await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(10_000) })).json()) as { blockchain: string; symbol: string; assetId: string }[];
      const from = tokens.find((t) => t.blockchain === "sol" && t.symbol === "USDC")?.assetId;
      const to = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC")?.assetId;
      assets = from && to ? { from, to } : null;
    } catch {
      return null;
    }
  }
  if (!assets) return null;
  const q = await oneClickDryQuote({ originAsset: assets.from, destinationAsset: assets.to, amountOut: amountUnits, recipient: "nearchant.near", refundTo: "nearchant.near" });
  return q ? { ...q, label: "USDC on Solana" } : null;
}

// Flow 3 seller side: synchronous A2A tasks run with the service's Agent Environment, metered to the seller.
let router: Router | null = null;
const envs = new Map<string, AgentEnv>();
async function getRouter(): Promise<Router> {
  if (!router) {
    router = Router.fromConfig(parse(readFileSync(join(configDir, process.env.PROVIDERS_FILE ?? "providers.yaml"), "utf8")));
    await router.discover();
  }
  return router;
}
async function executeA2a(handle: { account_id: string }, service: Service, text: string, paymentId: string): Promise<string> {
  if (!router) {
    router = Router.fromConfig(parse(readFileSync(join(configDir, process.env.PROVIDERS_FILE ?? "providers.yaml"), "utf8")));
    await router.discover();
  }
  const name = service.agentEnv!;
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("bad agent env name");
  if (!envs.has(name)) envs.set(name, loadAgentEnv(join(configDir, "../envs", name)));
  const env = envs.get(name)!;
  const envelopes = conn ? new Envelopes(conn.db) : null;
  const ask = makeAsker(env, router, async (e) => { await envelopes?.add(`a2a:${paymentId}`, "a2a", handle.account_id, e); });
  const roleName = Object.keys(env.roles)[0]!;
  const out = await ask<unknown>(roleName, `<draft>\n${text.replaceAll("</draft>", "<\\/draft>")}\n</draft>`);
  return typeof out === "string" ? out : JSON.stringify(out, null, 1);
}

// Telegram (ADR 0011): sealed per-seller tokens; webhook when public_url is https, long polling otherwise.
const sealer = process.env.NEARCHANT_SECRET_KEY ? new Sealer(process.env.NEARCHANT_SECRET_KEY) : null;
const useWebhooks = config.public_url.startsWith("https://") && !config.public_url.includes("localhost");
const polling = new Set<string>();
async function botShop(handle: string) {
  const h = await handles.get(handle);
  if (!h) throw new Error(`no handle ${handle}`);
  const services = await store.listServices(handle);
  const cardUrl = useWebhooks ? `https://${handle}.${config.base_domains[0]}/` : `${config.public_url}/h/${handle}/`;
  return {
    h,
    shop: { handle, name: h.card.name, cardUrl, services: services.filter((s) => !s.agentEnv).map((s) => ({ id: s.id, title: s.title, deliveryHours: s.deliveryHours, priceDisplay: `${formatUnits(s.priceUnits, config.token.decimals)} ${config.token.symbol}` })) },
  };
}
const chatLimit = new RateLimit(10, 10 * 60_000);
async function onTelegramUpdate(handle: string, update: TgUpdate) {
  // Each chat message costs the seller a model call: cap it per chat (security review M5).
  const chatId = update.message?.chat.id;
  if (chatId !== undefined && !chatLimit.take(`${handle}:${chatId}`)) return;
  const token = await getSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-token");
  if (!token) return;
  const { h, shop } = await botShop(handle);
  await handleUpdate(new TelegramApi(token), shop, update, async (text) => {
    if (!router) { router = Router.fromConfig(parse(readFileSync(join(configDir, process.env.PROVIDERS_FILE ?? "providers.yaml"), "utf8"))); await router.discover(); }
    if (!envs.has("deck-seller")) envs.set("deck-seller", loadAgentEnv(join(configDir, "../envs/deck-seller")));
    const envelopes = new Envelopes(conn!.db);
    const ask = makeAsker(envs.get("deck-seller")!, router, async (e) => { await envelopes.add(`tg:${handle}:${update.update_id}`, "chat", h.account_id, e); });
    return ask<string>("buyer-chat", `<draft>\n${JSON.stringify({ card: h.card, catalog: shop.services })}\n</draft>\n<brief>\n${text.replaceAll("</brief>", "<\\/brief>")}\n</brief>`);
  });
}
function startPolling(handle: string) {
  if (polling.has(handle)) return;
  polling.add(handle);
  let offset = 0;
  const loop = async () => {
    while (polling.has(handle)) {
      try {
        const token = await getSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-token");
        if (!token) break;
        const updates = await new TelegramApi(token).call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
        for (const u of updates) { offset = u.update_id + 1; await onTelegramUpdate(handle, u).catch((e) => console.warn(`[telegram] ${handle}: ${e.message}`)); }
      } catch (e) {
        console.warn(`[telegram] poll ${handle}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  void loop();
}
if (conn && sealer && !useWebhooks) for (const h of await handlesWithSecret({ db: conn.db }, "telegram-token")) startPolling(h);

const checkoutFile = join(import.meta.dirname, "web/checkout.js");
/** A full-access key of the account = the owner (agent keys are function-call only). */
const isOwnerKey = async (accountId: string, publicKey: string) => {
  const k = await chain.provider.viewAccessKey({ accountId, publicKey, finality: "optimistic" } as never).catch(() => null) as { permission?: unknown } | null;
  return k?.permission === "FullAccess";
};

const mediaDir = process.env.MEDIA_DIR ?? join(configDir, "../.media");
// The home page at nearchant.com: real counts and the latest posts with a proof on NEAR (ADR 0018, Figma Landing).
const landingCfg = { base: "/", rpcUrl: config.rpc_urls[0] ?? "", network: config.network, token: config.token.symbol, decimals: config.token.decimals, storeBase: config.public_url.startsWith("https://") && process.env.STORE_SUBDOMAINS !== "off" ? new URL(config.public_url).host : "" };
const landing = conn ? async () => {
  const sc = await new ContentStore(conn.db).showcase(3);
  const posts = sc.posts.map((p) => ({ caption: p.caption, img: p.publicImage ? `/files/${p.publicImage}?w=640` : null, proofId: p.proofId, store: p.storeName, href: `/h/${p.handle}/p/${p.id}?ref=landing`, line: `${p.storeName}${p.proofId ? ` · proof #${p.proofId}` : ""}` }));
  return LandingPage({ cfg: landingCfg, test: config.token.test, d: { posts, stats: { proofs: sc.proofs, paidOrders: sc.paidOrders, stores: sc.stores }, verifyHref: posts[0]?.proofId ? `/verify/${posts[0].proofId}` : "/verify", limits: { free: PLAN_LIMITS.free!, pro: PLAN_LIMITS.pro! } } });
} : undefined;

const checkoutJs = existsSync(checkoutFile) ? readFileSync(checkoutFile, "utf8") : undefined;
if (checkoutJs) assetV.checkout = createHash("sha256").update(checkoutJs).digest("hex").slice(0, 10);

// Outgoing email (ADR 0021): on when config email.* and RESEND_API_KEY are set.
const mailer = config.email && process.env.RESEND_API_KEY ? resendMailer({ apiKey: process.env.RESEND_API_KEY, from: config.email.from, apiUrl: config.email.api_url }) : undefined;
if (!mailer) console.info("[gateway] email off (no RESEND_API_KEY)");

// Shop feed store (ADR 0022), used by the store pages ("More like this") and the feed.
const feedStore = conn ? new FeedStore(conn.db) : null;
const orderOnChain = (id: string) => chain.view<{ status: string } | null>(accounts.orders, "get_order", { order_id: id });
// An email about an order to the store or the buyer, when we know their address (a failed email never blocks).
const mailAbout = async (to: string | null | undefined, subject: string, lines: string[], url: string, key: string) => {
  if (!to || !mailer) return;
  await mailer({ to, subject, idempotencyKey: key, text: `${lines.join("\n\n")}\n\n${url}`, html: emailHtml({ title: subject, lines, button: { label: "Open the order", url } }) })
    .catch((e) => console.warn(`[gateway] order email: ${(e as Error).message}`));
};
const buyerKey = createHash("sha256").update(`nearchant-buyer:${process.env.NEARCHANT_SECRET_KEY ?? "dev"}`).digest();

const app = createApp({
  // Review copies only (UI_LANGS="en,ru,uk"): a language switch + translated interface. Production: English only.
  beforeRoutes: (a) => mountI18n(a, { langs: parseLangs(process.env.UI_LANGS), dir: join(import.meta.dirname, "../i18n"),
    clientJs: existsSync(join(import.meta.dirname, "../dist/web/i18n.js")) ? readFileSync(join(import.meta.dirname, "../dist/web/i18n.js"), "utf8") : undefined,
    secureCookies: config.public_url.startsWith("https://") }),
  ...(landing ? { landing } : {}),
  config,
  handles,
  store,
  rail: new TestnetDirectRail(accounts, chain.view),
  anyChainQuote,
  mediaDir,
  checkoutJs: checkoutJs,
  client: { rpcUrl: config.rpc_urls[0]!, orders: accounts.orders, network: config.network, token: { contract: accounts.nusd, symbol: config.token.symbol, decimals: config.token.decimals } },
  ...(relayerKey && config.network === "testnet" ? { sponsorBuyer: (pk: string, allowNew: () => boolean) => sponsorBuyer({ chain, accounts }, pk, allowNew) } : {}),
  isAvailable: (h: string) => chain.view<boolean>(accounts.root, "is_available", { name: h }),
  stats: async (accountId: string, handle: string) => {
    const [wallet, billing, campaign] = await Promise.all([
      chain.view<string>(accounts.nusd, "ft_balance_of", { account_id: accountId }),
      chain.view<any>(accounts.billing, "get_account", { account_id: accountId }),
      chain.view<any>(accounts.escrow, "get_campaign", { campaign_id: `${handle}-main` }),
    ]);
    return { wallet, billing, campaign };
  },
  ...(conn && relayerKey && process.env.NEARCHANT_SECRET_KEY && config.network === "testnet" ? {
    createShop: async (s: { handle: string; ownerPublicKey: string; name: string; bio: string; priceUnits: string }) => {
      const r = await createShop({ chain, accounts, db: conn!.db, sealer: new Sealer(process.env.NEARCHANT_SECRET_KEY!) },
        { handle: s.handle, ownerPublicKey: s.ownerPublicKey, card: { name: s.name, bio: s.bio, avatar_hash: null, links: [] } });
      await store.upsertService({
        id: `${s.handle}-pitch-deck`, handle: s.handle, title: "Pitch deck in 1 hour", priceUnits: s.priceUnits, deliveryHours: 1, active: true,
        description: "An investor deck from your brief — researched, debated, written and designed by my agent team. PDF + PPTX.",
      });
      handles.invalidate(s.handle);
      return r;
    },
  } : {}),
  ...(conn && sealer ? {
    telegram: {
      isOwnerKey,
      connect: async (handle: string, token: string, webhookUrl: string, secret: string) => {
        const api = new TelegramApi(token);
        const me = await api.call<{ username: string }>("getMe", {});
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-token", token);
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-secret", secret);
        if (useWebhooks) await api.call("setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: ["message"] });
        else { await api.call("deleteWebhook", {}); startPolling(handle); }
        // Shown in Settings → Where posts go.
        await new ContentStore(conn!.db).setSetting(`telegramBot:${handle}`, me.username);
        return { username: me.username };
      },
      secretFor: (handle: string) => getSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-secret"),
      onUpdate: onTelegramUpdate,
    },
  } : {}),
  ...(conn && sealer ? {
    market: {
      connect: async (handle: string, token: string, webhookSecret: string) => {
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "market-token", token);
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "market-webhook-secret", webhookSecret);
      },
      secretFor: (handle: string) => getSecret({ db: conn!.db, sealer: sealer! }, handle, "market-webhook-secret"),
      // A market hire is paid in the market's escrow: it enters the same swarm as a paid order (ADR 0010).
      onHire: async (handle: string, hire: HireCreated) => {
        const orderId = marketOrderId(hire.assignment_id);
        if (await store.getOrder(orderId)) return;
        const service = (await store.listServices(handle)).find((x) => !x.agentEnv);
        if (!service) throw new Error(`${handle} has no orderable service`);
        const now = new Date().toISOString();
        const brief = [hire.title, hire.description].filter(Boolean).join("\n\n").slice(0, 4000);
        await store.createOrder({ orderId, handle, serviceId: service.id, amount: "0", brief, buyerAccountId: null, state: "paid", createdAt: now, updatedAt: now });
        await queue?.addJob("deck_step", { orderId, step: "brief" }, { jobKey: `${orderId}:brief`, maxAttempts: 5 });
        console.info(`[gateway] market hire ${hire.assignment_id} for ${handle} → ${orderId}`);
      },
    },
  } : {}),
  ...(conn ? {
    a2a: {
      network: config.network,
      asset: accounts.nusd,
      getPayment: (id: string) => chain.view(accounts.escrow, "get_payment", { payment_id: id }),
      claim: (row: { paymentId: string; handle: string; taskId: string; amount: string }) => claimA2aPayment(conn!.db, row),
      cached: (id: string) => a2aResult(conn!.db, id),
      save: (id: string, result: string) => saveA2aResult(conn!.db, id, result),
      execute: executeA2a,
    },
  } : {}),
  ...(conn ? {
    // Checkout of a store item (ADR 0026): on sale now? ships? the store's question and options.
    itemForSale: async (handle: string, id: string) => {
      const i = await new ContentStore(conn!.db).getItem(handle, id);
      if (!i) return null;
      const det = (i.details ?? {}) as ItemDetails;
      return { kind: i.kind, sellable: i.active && !i.held && !soldOut(i.kind, det), ships: ships(i.kind, det), ...(det.question ? { question: det.question } : {}), ...(det.optionName ? { optionName: det.optionName } : {}), options: (i.options as string[]) ?? [] };
    },
    storeContact: async (handle: string) => {
      const cs = new ContentStore(conn!.db);
      return (await cs.getSetting<Contact>(`contactOf:${handle}`)) ?? null;
    },
    // Banners (ADR 0027): rendered once per (item text, photo, price, format) and kept with the store's public files.
    banner: async (handle: string, itemId: string, format: string) => {
      if (!isBannerFormat(format)) return null;
      const cs = new ContentStore(conn!.db);
      const [i, b] = await Promise.all([cs.getItem(handle, itemId), cs.getBusiness(handle)]);
      if (!i || !b || !i.active || i.held || b.suspendedAt) return null;
      const det = (i.details ?? {}) as ItemDetails;
      const price = `${det.priceFrom ? "From " : ""}${formatUnits(i.priceUnits, config.token.decimals)} ${config.token.symbol}`;
      const input = { title: i.title, price, store: b.name, facts: soldOut(i.kind, det) ? "Sold out" : itemFacts(i.kind, det).join(" · "), url: `${config.public_url}/h/${handle}/i/${i.id}?ref=banner`, kind: i.kind };
      const key = createHash("sha256").update(JSON.stringify({ v: 1, format, input, photo: i.photoMediaId })).digest("hex").slice(0, 16);
      const file = join(mediaDir, handle, "public", "banners", `${i.id}-${format}-${key}.png`);
      const cached = await readFile(file).catch(() => null);
      if (cached) return cached;
      const photo = i.photoMediaId ? await readFile(join(mediaDir, handle, "public", `item-${i.id}.jpg`)).catch(() => null) : null;
      const png = await renderBanner(format, { ...input, photo });
      await mkdir(join(mediaDir, handle, "public", "banners"), { recursive: true });
      await writeFile(file, png);
      return png;
    },
  } : {}),
  saveRevisionNote: artifacts ? async (orderId: string, note: string) => {
    await artifacts!.clear(orderId, "revision_note");
    await artifacts!.put(orderId, "revision_note", { note, at: new Date().toISOString() });
  } : undefined,
  progress: artifacts
    ? async (orderId) => {
        const all = (await artifacts!.all(orderId)) as Record<string, any>;
        const files = ((all.render?.files ?? []) as { kind: string; url: string }[]).filter((f) => f.kind !== "md");
        return { stepsDone: Object.keys(all).filter((k) => k !== "revision_note"), files, stopped: all.stopped ? `${all.stopped.kind}: ${all.stopped.reason}`.slice(0, 400) : null };
      }
    : undefined,
  ...(conn ? { askStore: async (handle: string, question: string) => {
    const cs = new ContentStore(conn!.db);
    const b = await cs.getBusiness(handle);
    if (!b || b.suspendedAt) throw new Error("no store"); // a paused store's assistant does not answer
    const items = (await cs.listItems(handle)).map((i) => ({ id: i.id, title: i.title, description: i.description, price: `${formatUnits(i.priceUnits, config.token.decimals)} ${config.token.symbol}`, options: (i.options as string[]) ?? [] }));
    const posts = (await cs.listPosts(handle, { status: ["published"], limit: 10 })).filter((p) => !p.removedAt).map((p) => p.caption ?? "");
    const r = await getRouter();
    if (!envs.has("content-store")) envs.set("content-store", loadAgentEnv(join(configDir, "../envs/content-store")));
    const ask = makeAsker(envs.get("content-store")!, r, async () => {});
    const a = await Promise.race([answerShopper(ask, { question, store: { name: b.name, description: b.description, place: [b.city, b.country].filter(Boolean).join(", "), ships: b.ships ?? "" }, items, posts }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 45_000))]);
    // The owner sees what shoppers ask (Analytics), newest first.
    await cs.prependSetting(`questions:${handle}`, { q: question.slice(0, 500), a: a.answer, owner: a.askOwner, at: new Date().toISOString() }, 50);
    return a;
  } } : {}),
  ...(conn ? { onOrderCreated: async (c: import("hono").Context, orderId: string, handle: string) => {
    const buyer = readSession(buyerKey, getCookie(c, "nc_buyer"));
    if (!buyer) return;
    await new ContentStore(conn!.db).prependSetting(`buyerOrders:${buyer}`, { orderId, handle, at: new Date().toISOString() }, 200);
    await new ContentStore(conn!.db).setSetting(`orderBuyer:${orderId}`, buyer); // so the store's replies can reach them
  } } : {}),
  ...(feedStore ? {
    blockedIp: (ip: string) => feedStore.isBlocked(ip),
    onShopCreated: async (handle: string, ip: string) => {
      await feedStore.logIp("store", handle, ip);
      const links = await feedStore.linkedViolators({ ips: [ip], accounts: [`${handle}.${accounts.root}`], except: { kind: "store", id: handle } });
      if (links.length) await feedStore.log("system", "account.linked", `store:${handle}`, { ip, violators: links.map((v) => `${v.subjectKind}:${v.subjectId}`) });
    },
  } : {}),
  ...(conn ? { suspended: async (h: string) => !!(await new ContentStore(conn!.db).getBusiness(h))?.suspendedAt } : {}),
  ...(feedStore ? { similar: async (postId: string) => (await feedStore.similar(postId, 8)).map((x) => ({ id: x.id, handle: x.handle, storeName: x.storeName, caption: x.caption, img: `/files/${x.publicImage}?w=640`, video: !!x.publicVideo })) } : {}),
  ...(conn ? { storefront: async (handle: string, view?: { source: string | null; itemId?: string; postId?: string }) => {
    const cs = new ContentStore(conn!.db);
    const b = await cs.getBusiness(handle);
    if (!b || b.suspendedAt) return null; // suspended by moderation (ADR 0022): the store page is gone
    // A post page view counts for that post (Analytics → Top posts "views from its link").
    if (view) await cs.addEvent({ handle, kind: "view", source: view.source, itemId: view.itemId ?? null, postId: view.postId ?? null }).catch(() => {});
    const prof = (await cs.getProfile(handle))?.data as { summary?: string } | undefined;
    const items = await cs.listItems(handle);
    const posts = (await cs.listPosts(handle, { status: ["published"], limit: 60 })).filter((p) => !p.removedAt);
    if (view?.postId && !posts.some((p) => p.id === view.postId)) {
      const one = await cs.getPost(view.postId);
      if (one && one.handle === handle && one.status === "published" && !one.passedAt && !one.removedAt) posts.push(one);
    }
    const fmt = (u: string) => `${formatUnits(u, config.token.decimals)} ${config.token.symbol}`;
    const likes = await new FeedStore(conn!.db).likeCounts(posts.map((p) => p.id));
    return {
      handle, name: b.name, account: `${handle}.${accounts.root}`, summary: prof?.summary ?? b.description,
      orders: (await store.listOrders(handle, 500)).filter((o) => ["paid", "in_progress", "delivered", "released"].includes(o.state)).length,
      items: items.map((i) => ({ id: i.id, title: i.title, description: i.description, price: fmt(i.priceUnits), kind: i.kind, options: i.options as string[], details: (i.details ?? {}) as ItemDetails, img: i.photoMediaId ? `/files/${handle}/public/item-${i.id}.jpg?w=640&v=${createHash("sha256").update(`${i.photoMediaId}|${i.title}`).digest("hex").slice(0, 8)}` : null })),
      posts: posts.map((p) => ({ id: p.id, itemId: p.itemId, publishedAt: (p.publishedAt ?? p.createdAt).toISOString(), hashtags: (p.hashtags as string[]) ?? [], caption: p.caption ?? "", img: (p.idea as { publicImage?: string }).publicImage ? `/files/${(p.idea as { publicImage: string }).publicImage}?w=640` : null, video: (p.idea as { publicVideo?: string }).publicVideo ? `/files/${(p.idea as { publicVideo: string }).publicVideo}?v=${((p.idea as { video?: { mediaId?: string } }).video?.mediaId ?? "").slice(-8)}` : null, proofId: (p.proof as { proofId?: string } | null)?.proofId ?? null, likes: likes.get(p.id) ?? 0 })),
    };
  } } : {}),
  onPaid: async (id) => {
    if (!queue) return console.warn(`[gateway] order ${id} paid, but there is no queue (DATABASE_URL unset)`);
    const order = await store.getOrder(id);
    if (order?.serviceId.startsWith("i-")) {
      // A store item (ADR 0018): no AI job — the seller ships, then marks it shipped; the sale feeds analytics.
      if (conn) await new ContentStore(conn.db).addEvent({ handle: order.handle, kind: "sale", itemId: order.serviceId, orderId: id, data: { amount: order.amount } });
      // Tell the owner by email (if they linked one); a failed email never blocks the sale.
      if (conn && mailer) void (async () => {
        const cs = new ContentStore(conn.db);
        const to = await cs.getSetting<string>(`emailOf:${order.handle}`);
        if (!to) return;
        const item = await cs.getItem(order.handle, order.serviceId);
        const amount = `${formatUnits(order.amount, config.token.decimals)} ${config.token.symbol}`, what = item?.title ?? "an item";
        const c = order.contact;
        const lines = [`Someone bought ${what} for ${amount}. The money is held in escrow on NEAR until the buyer confirms they got it.`,
          ...(c ? [`Buyer: ${c.name ?? ""} — ${contactLine(c)}`, ...(c.address ? [`Deliver to: ${c.address}`] : [])] : []),
          ...(order.brief ? [`Their note: ${order.brief.slice(0, 300)}`] : []), "Contact the buyer if you need to, ship it, then mark it shipped in your store."];
        await mailer({ to, subject: `New order: ${what} — ${amount}`, idempotencyKey: `order-paid:${id}`, text: `${lines.join("\n\n")}\n\n${config.public_url}/app/orders/${id}`,
          html: emailHtml({ title: `New order: ${what}`, lines, button: { label: "Open the order", url: `${config.public_url}/app/orders/${id}` } }) });
      })().catch((e) => console.warn(`[gateway] order email ${id}: ${(e as Error).message}`));
      // The buyer's receipt with the private link to their order (there are no buyer accounts to find it again).
      if (conn && order.contact?.email) void (async () => {
        const cs = new ContentStore(conn.db);
        const [b, item, sc] = await Promise.all([cs.getBusiness(order.handle), cs.getItem(order.handle, order.serviceId), cs.getSetting<Contact>(`contactOf:${order.handle}`)]);
        const name = b?.name ?? order.handle, amount = `${formatUnits(order.amount, config.token.decimals)} ${config.token.symbol}`;
        await mailAbout(order.contact!.email, `Your order from ${name}`, [`You paid ${amount} for ${item?.title ?? "your order"}. The money waits in escrow on NEAR until you confirm you got it.`,
          ...(sc ? [`Questions? Contact ${name}: ${contactLine(sc)}`] : []), "Keep this email: the button opens your order."], `${config.public_url}/h/${order.handle}/o/${id}`, `order-buyer:${id}`);
      })();
      console.info(`[gateway] order ${id} paid on chain → item sale for ${order.handle}`);
      return;
    }
    await queue.addJob("deck_step", { orderId: id, step: "brief" }, { jobKey: `${id}:brief`, maxAttempts: 5 });
    console.info(`[gateway] order ${id} paid on chain → swarm job queued`);
  },
});

// Shop feed + buyers (ADR 0022). Search: the search-planner reads the query, NEAR AI embeds it; both cached.
const intentCache = new Map<string, { at: number; v: SearchIntent }>();
async function understand(q: string): Promise<SearchIntent> {
  const key = q.trim().toLowerCase();
  const hit = intentCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const r = await getRouter();
  if (!envs.has("content-store")) envs.set("content-store", loadAgentEnv(join(configDir, "../envs/content-store")));
  const ask = makeAsker(envs.get("content-store")!, r, async () => {});
  const plan = await Promise.race([planSearch(ask, q), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("planner timeout")), 15_000))]).catch(() => null);
  const text = plan ? [plan.goods.join(", "), plan.terms.join(" ")].filter(Boolean).join("\n") : q;
  // One embedding call: the whole query plus each good on its own ("stores that sell 1, 2, 3, 4").
  const goods = (plan?.goods ?? []).slice(0, 6);
  // Qwen3-Embedding works best with an instruction on the query side: per-good matches separate far better
  // (measured 3 Nov: true matches 0.47–0.58, non-matches ≤ 0.41; without it they overlapped).
  const asGood = (g: string) => `Instruct: Given a product a shopper wants to buy, retrieve the store items and posts that sell it\nQuery: ${g}`;
  const vectors = await r.call({ capability: "embed", dataClass: "public", timeoutMs: 10_000, input: { input: [text || q, ...goods.map(asGood)] } })
    .then((e) => (e.output as { vectors?: number[][] }).vectors ?? null).catch(() => null);
  const vector = vectors?.[0] ?? null;
  const goodVectors = vectors && vectors.length === goods.length + 1 ? goods.map((name, i) => ({ name, vector: vectors[i + 1]! })) : [];
  const maxPriceUnits = plan?.maxPrice ? (BigInt(Math.round(plan.maxPrice * 100)) * 10n ** BigInt(config.token.decimals) / 100n).toString() : null;
  const v: SearchIntent = { maxPriceUnits, goodVectors, goods: plan?.goods ?? [], summary: plan?.summary || q, terms: plan?.terms.length ? plan.terms : q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1), city: plan?.city ?? null, country: plan?.country ?? null, vector };
  if (intentCache.size > 500) intentCache.clear();
  intentCache.set(key, { at: Date.now(), v });
  return v;
}
/** "Try" chips on the feed: real item titles from stores with posts, refreshed every 10 minutes. */
let sugg: { at: number; v: string[] } = { at: 0, v: [] };
async function suggestions(): Promise<string[]> {
  if (!conn || Date.now() - sugg.at < 10 * 60_000) return sugg.v;
  const rows = (await conn.db.execute(sql`select distinct on (lower(i.title)) i.title from items i join businesses b on b.handle = i.handle where i.active and b.suspended_at is null
    and exists (select 1 from posts p where p.handle = i.handle and p.status = 'published' and p.removed_at is null) order by lower(i.title) limit 30`)) as unknown as { title: string }[];
  sugg = { at: Date.now(), v: rows.map((r) => r.title).sort(() => Math.random() - 0.5).slice(0, 6) };
  return sugg.v;
}

// The seller app API (ADR 0018): needs Postgres for content and the secret key for session cookies.
if (conn && process.env.NEARCHANT_SECRET_KEY) {
  mountSellerApp(app, {
    content: new ContentStore(conn.db), handles, isOwnerKey, mediaDir,
    mirrorService: (x) => store.upsertService({ id: x.id, handle: x.handle, title: x.title, description: x.description, priceUnits: x.priceUnits, deliveryHours: 7 * 24, active: x.active ?? true }),
    ...(sealer ? { marketConnect: async (handle: string, token: string, webhookSecret: string) => {
      await putSecret({ db: conn.db, sealer: sealer! }, handle, "market-token", token);
      await putSecret({ db: conn.db, sealer: sealer! }, handle, "market-webhook-secret", webhookSecret);
    } } : {}),
    orders: {
      list: (h) => store.listOrders(h, 50),
      // enqueueAgain: shipping again after a revision gets a new outbox item (the first one is done).
      ship: async (h, orderId, note) => { await new Outbox(conn.db).enqueueAgain(`ship:${orderId}`, "item.ship", { orderId, handle: h, note }); },
      status: orderOnChain,
      refund: async (h, orderId) => { await new Outbox(conn.db).enqueueAgain(`refund:${orderId}`, "item.refund", { orderId, handle: h }); },
      declineRefund: async (h, orderId) => { await new Outbox(conn.db).enqueueAgain(`refund-decline:${orderId}`, "item.refund_decline", { orderId, handle: h }); },
      action: async (orderId) => {
        const ob = new Outbox(conn.db);
        const rows = (await Promise.all([`ship:${orderId}`, `refund:${orderId}`, `refund-decline:${orderId}`].map((k) => ob.latest(k)))).filter((r) => r !== null);
        const last = rows.sort((a, b) => b.id - a.id)[0];
        if (!last || last.state === "done") return null;
        return { kind: last.kind, state: last.state, attempts: last.attempts, error: last.lastError, at: last.updatedAt.toISOString(), since: last.createdAt.toISOString() };
      },
    },
    enqueue: async (task, payload, jobKey) => {
      if (!queue) throw new Error("no job queue (DATABASE_URL unset)");
      await queue.addJob(task, payload, { ...(jobKey ? { jobKey } : {}), maxAttempts: 3 });
    },
    sessionKey: createHash("sha256").update(`nearchant-session:${process.env.NEARCHANT_SECRET_KEY}`).digest(),
    secureCookies: config.public_url.startsWith("https://"),
    decimals: config.token.decimals,
    videoEnabled: !!(process.env.TTS_URL && process.env.COMFY_API_KEY),
    walletRecipient: new URL(config.public_url).host,
    ...(mailer ? { mail: mailer } : {}), publicUrl: config.public_url,
    ...(feedStore ? { logIp: (k: "store", id: string, ip: string) => feedStore.logIp(k, id, ip) } : {}),
    ...(feedStore ? { buyerOf: async (c: import("hono").Context) => {
      const id = readSession(buyerKey, getCookie(c, "nc_buyer"));
      const b = id ? await feedStore.getBuyer(id) : null;
      return b && b.status === "active" ? { email: b.email, wallet: b.wallet } : null;
    } } : {}),
  });
  const queueJob = async (task: string, payload: Record<string, unknown>, jobKey?: string) => {
    if (!queue) throw new Error("no job queue (DATABASE_URL unset)");
    await queue.addJob(task, payload, { ...(jobKey ? { jobKey } : {}), maxAttempts: 3 });
  };
  mountBuyerApp(app, {
    feed: feedStore!, content: new ContentStore(conn.db), isOwnerKey, enqueue: queueJob, understand, key: buyerKey,
    sellerKey: createHash("sha256").update(`nearchant-session:${process.env.NEARCHANT_SECRET_KEY}`).digest(),
    orderOf: async (id: string) => { const o = await store.getOrder(id); return o ? { handle: o.handle } : null; },
    secureCookies: config.public_url.startsWith("https://"), walletRecipient: new URL(config.public_url).host, publicUrl: config.public_url,
    ...(mailer ? { mail: mailer } : {}),
  });
}
{
  const appFile = join(import.meta.dirname, "../dist/web/app.js");
  const sessionKey = createHash("sha256").update(`nearchant-session:${process.env.NEARCHANT_SECRET_KEY ?? "dev"}`).digest();
  // STORE_SUBDOMAINS=off (review copies on a host without a wildcard): store links stay on /h/<handle>/.
  const storeBase = config.public_url.startsWith("https://") && process.env.STORE_SUBDOMAINS !== "off" ? new URL(config.public_url).host : "";
  mountUi(app, {
    cfg: { base: "/", rpcUrl: config.rpc_urls[0] ?? "", network: config.network, token: config.token.symbol, decimals: config.token.decimals, storeBase, tokenContract: accounts.nusd, accountSuffix: accounts.root },
    test: config.token.test, css: readFileSync(join(import.meta.dirname, "../web/ui.css"), "utf8"),
    js: existsSync(appFile) ? readFileSync(appFile, "utf8") : undefined, sessionKey, emailOn: !!mailer,
    ...(conn ? { content: new ContentStore(conn.db) } : {}),
    accountOf: (h) => `${h}.${accounts.root}`,
    orders: (h) => store.listOrders(h, 50),
    orderStatus: orderOnChain, ordersContract: accounts.orders,
    marketOn: !!(conn && sealer),
    balances: async (a) => {
      const [wallet, billing] = await Promise.all([
        chain.view<string>(accounts.nusd, "ft_balance_of", { account_id: a }),
        chain.view<{ balance: string; spent_month: string } | null>(accounts.billing, "get_account", { account_id: a }).catch(() => null),
      ]);
      return { wallet, billing };
    },
    explorer: (a) => `https://${config.network === "mainnet" ? "" : "testnet."}nearblocks.io/address/${a}`,
    proof: (id) => chain.view(accounts.proofs, "get", { proof_id: id }),
    proofsContract: accounts.proofs, mediaDir,
    ...(feedStore ? { feedStore, understand, buyerKey, suggestions: async () => suggestions() } : {}),
    buyerOrders: async (buyer: string) => {
      const list = conn ? (await new ContentStore(conn.db).getSetting<{ orderId: string; handle: string; at: string }[]>(`buyerOrders:${buyer}`)) ?? [] : [];
      const rows = await Promise.all(list.map(async (x) => {
        const o = await store.getOrder(x.orderId);
        if (!o || o.state === "awaiting_payment") return null;
        const b = conn ? await new ContentStore(conn.db).getBusiness(x.handle) : null;
        const item = conn ? await new ContentStore(conn.db).getItem(x.handle, o.serviceId) : null;
        return { orderId: o.orderId, handle: x.handle, store: b?.name ?? x.handle, title: item?.title ?? "Order", amount: `${formatUnits(o.amount, config.token.decimals)} ${config.token.symbol}`, state: o.state, at: o.createdAt };
      }));
      return rows.filter((r): r is NonNullable<typeof r> => !!r).slice(0, 50); // unpaid checkouts never push paid orders out
    },
    ...(existsSync(join(import.meta.dirname, "../dist/web/buyer.js")) ? { buyerJs: readFileSync(join(import.meta.dirname, "../dist/web/buyer.js"), "utf8") } : {}),
    ...(existsSync(join(import.meta.dirname, "../dist/web/wallet.js")) ? { walletJs: readFileSync(join(import.meta.dirname, "../dist/web/wallet.js"), "utf8") } : {}),
  });
}

// Admin (owner only): a second listener that is published on the tailnet address only, never via the tunnel.
if (conn && process.env.ADMIN_PORT) {
  const lab = parse(readFileSync(join(configDir, "image-lab.yaml"), "utf8")) as { variants: LabVariant[] };
  const workflows = Object.fromEntries([...new Set(lab.variants.map((v) => v.workflow))].map((f) => [f, JSON.parse(readFileSync(join(configDir, "image-lab", f), "utf8"))]));
  // Moderation (ADR 0022) + its login guard every admin page, the image lab included.
  const admin = new Hono();
  if (!process.env.ADMIN_PASSWORD) console.warn("[admin] ADMIN_PASSWORD is not set — nobody can sign in to the admin panel");
  mountModeration(admin, { feed: feedStore!, content: new ContentStore(conn.db), mediaDir, password: process.env.ADMIN_PASSWORD ?? "", accountOf: (h) => `${h}.${accounts.root}`,
    key: createHash("sha256").update(`nearchant-admin:${process.env.NEARCHANT_SECRET_KEY ?? "dev"}`).digest() });
  admin.route("/", labApp({ db: conn.db, comfy: process.env.COMFY_API_KEY ? new ComfyCloud(process.env.COMFY_API_KEY) : null, variants: lab.variants, workflows, mediaDir }));
  serve({ fetch: admin.fetch, hostname: "0.0.0.0", port: Number(process.env.ADMIN_PORT) }, (i) => console.info(`[admin] image lab on :${i.port} (publish on the tailnet only)`));
}

serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (i) =>
  console.info(`[gateway] ${config.profile}/${config.network} on http://${i.address}:${i.port} (public ${config.public_url})`));
