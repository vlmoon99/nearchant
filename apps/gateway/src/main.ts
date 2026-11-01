// Gateway entry. env: DATABASE_URL (else in-memory), NEAR_RELAYER_KEY (buyer sponsorship), MEDIA_DIR, PUBLIC_URL, PORT.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { parse } from "yaml";
import { Artifacts, Envelopes, MemoryStore, PgStore, Sealer, a2aResult, claimA2aPayment, saveA2aResult, connect, createShop, getSecret, handlesWithSecret, putSecret, runMigrations, type Connection, type Service, type Store } from "@nearchant/db";
import { TelegramApi, handleUpdate, type TgUpdate } from "./telegram.js";
import { marketOrderId, type HireCreated } from "./market.js";
import { formatUnits } from "./config.js";
import { Router } from "@nearchant/providers";
import { loadAgentEnv, makeAsker, type AgentEnv } from "@nearchant/swarm";
import { Chain, HandleCache, TestnetDirectRail, loadAccounts, oneClickDryQuote } from "@nearchant/near";
import { createApp } from "./app.js";
import { RateLimit, sponsorBuyer } from "./buyers.js";
import { loadGatewayConfig } from "./config.js";

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
  await runMigrations(conn.db);
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
const app = createApp({
  config,
  handles,
  store,
  rail: new TestnetDirectRail(accounts, chain.view),
  anyChainQuote,
  mediaDir: process.env.MEDIA_DIR ?? join(configDir, "../.media"),
  checkoutJs: existsSync(checkoutFile) ? readFileSync(checkoutFile, "utf8") : undefined,
  client: { rpcUrl: config.rpc_urls[0]!, orders: accounts.orders, network: config.network },
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
      isOwnerKey: async (accountId: string, publicKey: string) => {
        const k = await chain.provider.viewAccessKey({ accountId, publicKey, finality: "optimistic" } as never).catch(() => null) as { permission?: unknown } | null;
        return k?.permission === "FullAccess";
      },
      connect: async (handle: string, token: string, webhookUrl: string, secret: string) => {
        const api = new TelegramApi(token);
        const me = await api.call<{ username: string }>("getMe", {});
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-token", token);
        await putSecret({ db: conn!.db, sealer: sealer! }, handle, "telegram-secret", secret);
        if (useWebhooks) await api.call("setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: ["message"] });
        else { await api.call("deleteWebhook", {}); startPolling(handle); }
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
  progress: artifacts
    ? async (orderId) => {
        const all = (await artifacts!.all(orderId)) as Record<string, any>;
        const files = ((all.render?.files ?? []) as { kind: string; url: string }[]).filter((f) => f.kind !== "md");
        return { stepsDone: Object.keys(all), files, stopped: all.stopped ? `${all.stopped.kind}: ${all.stopped.reason}`.slice(0, 400) : null };
      }
    : undefined,
  onPaid: async (id) => {
    if (!queue) return console.warn(`[gateway] order ${id} paid, but there is no queue (DATABASE_URL unset)`);
    await queue.addJob("deck_step", { orderId: id, step: "brief" }, { jobKey: `${id}:brief`, maxAttempts: 5 });
    console.info(`[gateway] order ${id} paid on chain → swarm job queued`);
  },
});

serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, (i) =>
  console.info(`[gateway] ${config.profile}/${config.network} on http://${i.address}:${i.port} (public ${config.public_url})`));
