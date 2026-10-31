// Worker: one graphile-worker task per pipeline step (docs/swarm.md), plus the outbox drain.
// env: DATABASE_URL, NEARCHANT_SECRET_KEY, NEAR_RELAYER_KEY, NEARAI_API_KEY / NC_LOCAL_LLM_KEY (or REPLAY_DIR),
//      SEARXNG_URL?, RENDERER_URL, MEDIA_DIR, MEDIA_PUBLIC
import { join, resolve } from "node:path";
import { run, type Task } from "graphile-worker";
import { Artifacts, Envelopes, Outbox, PgStore, Sealer, connect, runMigrations } from "@nearchant/db";
import { Chain, loadAccounts } from "@nearchant/near";
import { PIPELINE, loadAgentEnv, runStep, type JobDeps, type Step } from "@nearchant/swarm";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { deliver, type DeliverPayload } from "./deliver.js";
import { makeRouter } from "./router.js";
import { localMedia, marpServerRender, searxng } from "./tools.js";

const root = resolve(import.meta.dirname, "../../..");
const need = (k: string) => process.env[k] ?? (console.error(`${k} is not set`), process.exit(2));
const gw = parse(readFileSync(join(root, "config/gateway.yaml"), "utf8"));
const accounts = loadAccounts(join(root, "config/defaults/accounts.yaml"), gw.network);
const conn = connect(need("DATABASE_URL"));
await runMigrations(conn.db);
const store = new PgStore(conn.db);
const artifacts = new Artifacts(conn.db);
const envelopes = new Envelopes(conn.db);
const outbox = new Outbox(conn.db);
const sealer = new Sealer(need("NEARCHANT_SECRET_KEY"));
const chain = new Chain({ rpcUrls: gw.rpc_urls, relayer: { accountId: accounts.relayer, secretKey: need("NEAR_RELAYER_KEY") } });
const router = await makeRouter(join(root, "config/providers.yaml"));
const media = localMedia(process.env.MEDIA_DIR ?? join(root, ".media"), process.env.MEDIA_PUBLIC ?? "/media");
const env = loadAgentEnv(join(root, "envs/deck-seller"));

const deckStep: Task = async (payload, helpers) => {
  const { orderId, step } = payload as { orderId: string; step: Step };
  if (!PIPELINE.includes(step)) throw new Error(`unknown step ${step}`);
  const order = await store.getOrder(orderId);
  if (!order) throw new Error(`no order ${orderId}`);
  await store.transitionOrder(orderId, "paid", "in_progress");
  const accountId = `${order.handle}.${accounts.root}`;
  const deps: JobDeps = {
    env, router, artifacts, media,
    record: (o, s, _role, e) => envelopes.add(o, s, accountId, e),
    render: process.env.RENDERER_URL ? marpServerRender(process.env.RENDERER_URL, media) : async () => { throw new Error("RENDERER_URL not set"); },
    deliver: async (o, proof) => {
      await outbox.enqueue(`deliver:${o}`, "deliver", { orderId: o, handle: order.handle, proof } satisfies DeliverPayload);
      await helpers.addJob("outbox_drain", {}, { jobKey: "outbox_drain", runAt: new Date() });
    },
    search: process.env.SEARXNG_URL ? searxng(process.env.SEARXNG_URL) : undefined,
    log: (m) => helpers.logger.info(m),
  };
  const out = await runStep(deps, orderId, order.brief, step);
  if (out.status === "stopped") {
    helpers.logger.warn(`${orderId} stopped at ${step}: ${out.kind} ${out.reason}`);
    await store.transitionOrder(orderId, "in_progress", "cancelled");
    return;
  }
  if (out.next) await helpers.addJob("deck_step", { orderId, step: out.next }, { jobKey: `${orderId}:${out.next}`, maxAttempts: 5 });
};

const outboxDrain: Task = async (_p, helpers) => {
  const n = await outbox.drain(async (kind, payload) => {
    if (kind === "deliver") return deliver({ chain, accounts, db: conn.db, sealer, store }, payload as DeliverPayload);
    throw new Error(`no handler for outbox kind ${kind}`);
  });
  if (n) helpers.logger.info(`outbox: sent ${n}`);
};

const runner = await run({
  connectionString: need("DATABASE_URL"),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  noHandleSignals: false,
  pollInterval: 1000,
  taskList: { deck_step: deckStep, outbox_drain: outboxDrain },
  crontab: "* * * * * outbox_drain ?jobKey=outbox_drain",
});
console.info(`[worker] up: ${Object.keys({ deck_step: 1, outbox_drain: 1 }).join(", ")}`);
await runner.promise;
