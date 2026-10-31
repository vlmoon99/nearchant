// Gateway entry. env: DATABASE_URL (else in-memory), NEAR_RELAYER_KEY (buyer sponsorship), MEDIA_DIR, PUBLIC_URL, PORT.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { parse } from "yaml";
import { Artifacts, MemoryStore, PgStore, connect, runMigrations, type Service, type Store } from "@nearchant/db";
import { Chain, HandleCache, TestnetDirectRail, loadAccounts, oneClickDryQuote } from "@nearchant/near";
import { createApp } from "./app.js";
import { sponsorBuyer } from "./buyers.js";
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
if (process.env.DATABASE_URL) {
  const conn = connect(process.env.DATABASE_URL);
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
  ...(relayerKey && config.network === "testnet" ? { sponsorBuyer: (pk: string) => sponsorBuyer({ chain, accounts }, pk) } : {}),
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
