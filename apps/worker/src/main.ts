// Worker: one graphile-worker task per pipeline step (docs/swarm.md), plus the outbox drain.
// env: DATABASE_URL, NEARCHANT_SECRET_KEY, NEAR_RELAYER_KEY, NEARAI_API_KEY / NC_LOCAL_LLM_KEY (or REPLAY_DIR),
//      SEARXNG_URL?, RENDERER_URL, MEDIA_DIR, MEDIA_PUBLIC
import { join, resolve } from "node:path";
import { run, type Task } from "graphile-worker";
import { Artifacts, Envelopes, Outbox, PgStore, Sealer, connect, runMigrations } from "@nearchant/db";
import { Chain, loadAccounts } from "@nearchant/near";
import { PIPELINE, hireAgent, loadAgentEnv, runStep, type JobDeps, type Step } from "@nearchant/swarm";
import { agentKey } from "@nearchant/db";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { deliver, type DeliverPayload } from "./deliver.js";
import { buildBatch, leafHash, usageRecord } from "@nearchant/billing";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { ResultEnvelope } from "@nearchant/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
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
const router = await makeRouter(join(root, "config", process.env.PROVIDERS_FILE ?? "providers.yaml"));
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
      // One outbox item per delivery round (a revision redelivers with a new proof).
      const rev = o.startsWith("mkt-") ? 0 : ((await chain.view<{ revisions_used?: number } | null>(accounts.orders, "get_order", { order_id: o }))?.revisions_used ?? 0);
      await outbox.enqueue(`deliver:${o}:r${rev}`, "deliver", { orderId: o, handle: order.handle, proof } satisfies DeliverPayload);
      await helpers.addJob("outbox_drain", {}, { jobKey: "outbox_drain", runAt: new Date() });
    },
    search: process.env.SEARXNG_URL ? searxng(process.env.SEARXNG_URL) : undefined,
    hire: gw.hiring?.factcheck ? async (task) => {
      // Flow 3: pay from the seller's escrow campaign `<handle>-main` with its escrow function-call key.
      const key = await agentKey({ db: conn.db, sealer }, order.handle, "escrow-key");
      return hireAgent({
        fetch,
        maxAmount: BigInt(gw.hiring.factcheck.max_units),
        pay: (payTo, amount, memo) => chain.callAs(accountId, key, accounts.escrow, "pay", { campaign_id: `${order.handle}-main`, payee_id: payTo, amount, memo }, 100),
        paymentStatus: async (id) => (await chain.view<{ status: string } | null>(accounts.escrow, "get_payment", { payment_id: id }))?.status ?? null,
        log: (m) => helpers.logger.info(m),
      }, process.env.FACTCHECK_A2A_URL ?? gw.hiring.factcheck.a2a_url, `${orderId}-factcheck`, task);
    } : undefined,
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

// Flow 2 (architecture.md §4): envelopes → signed usage records → Merkle batch → billing.settle_batch.
const policy = { marginBps: Number(gw.billing?.margin_bps ?? 1000), unitsPerUsd: Number(gw.billing?.units_per_usd ?? 1_000_000) };
const signer = KeyPair.fromString(need("NEAR_RELAYER_KEY") as KeyPairString);
const billingSettle: Task = async (_p, helpers) => {
  if (gw.profile === "free-local") return;
  const rows = await envelopes.unsettled(400);
  if (rows.length === 0) return;
  const records = rows.map((r) => {
    const rec = usageRecord(`env-${r.id}`, r.accountId, r.envelope as ResultEnvelope, policy);
    return { ...rec, signature: Buffer.from(signer.sign(Buffer.from(leafHash(rec), "hex")).signature).toString("base64") };
  });
  const batch = buildBatch(`b-${rows[0]!.id}-${rows.at(-1)!.id}`, records);
  // The statement (all records + root) is published next to the deliverables so sellers can verify charges.
  mkdirSync(join(media.path("batches", "")), { recursive: true });
  writeFileSync(media.path("batches", `${batch.batchId}.json`), JSON.stringify({ ...batch, signer: signer.getPublicKey().toString() }, null, 1));
  await envelopes.settleInto(rows.map((r) => r.id), batch.batchId, "billing.settle", { batch_id: batch.batchId, merkle_root: batch.merkleRoot, entries: batch.entries });
  helpers.logger.info(`billing: batch ${batch.batchId} with ${records.length} records, ${batch.entries.length} charged accounts`);
  await helpers.addJob("outbox_drain", {}, { jobKey: "outbox_drain", runAt: new Date() });
};

const outboxDrain: Task = async (_p, helpers) => {
  const n = await outbox.drain(async (kind, payload) => {
    if (kind === "deliver") return deliver({ chain, accounts, db: conn.db, sealer, store, publicUrl: process.env.PUBLIC_URL }, payload as DeliverPayload);
    if (kind === "billing.settle") {
      const p = payload as { batch_id: string; merkle_root: string; entries: unknown[] };
      if (p.entries.length === 0) return { skipped: "no charges" };
      return { charged: await chain.call<string>(accounts.billing, "settle_batch", p, { gasTgas: 150 }) };
    }
    throw new Error(`no handler for outbox kind ${kind}`);
  });
  if (n) helpers.logger.info(`outbox: sent ${n}`);
};

// Escrow timers (docs/contracts.md): release delivered orders after their timeout, refund undelivered ones after the
// delivery deadline. Both contract methods are callable by anyone; the relayer pays the gas.
const escrowTimers: Task = async (_p, helpers) => {
  const rows = await store.ordersInStates(["delivered", "paid", "in_progress", "cancelled"], 200);
  const now = BigInt(Date.now()) * 1_000_000n;
  for (const row of rows) {
    if (row.orderId.startsWith("mkt-")) continue; // market hires settle in the market's escrow
    const o = await chain.view<{ status: string; delivered_at?: string; release_after_ns: string; deliver_by: string } | null>(accounts.orders, "get_order", { order_id: row.orderId }).catch(() => null);
    if (!o) continue;
    try {
      if (o.status === "Delivered" && o.delivered_at && now >= BigInt(o.delivered_at) + BigInt(o.release_after_ns)) {
        await chain.call(accounts.orders, "release_expired", { order_id: row.orderId }, { gasTgas: 100 });
        await store.transitionOrder(row.orderId, "delivered", "released");
        helpers.logger.info(`escrow: released ${row.orderId} after timeout`);
      } else if ((o.status === "Held" || o.status === "RevisionRequested") && now >= BigInt(o.deliver_by)) {
        await chain.call(accounts.orders, "refund_undelivered", { order_id: row.orderId }, { gasTgas: 100 });
        await store.transitionOrder(row.orderId, row.state, "refunded");
        helpers.logger.info(`escrow: refunded undelivered ${row.orderId}`);
      } else if (o.status === "RevisionRequested" && row.state === "delivered") {
        // The buyer asked for a revision: redo the deck from `write` on, with a fresh proof (security review H2).
        if (await store.transitionOrder(row.orderId, "delivered", "in_progress")) {
          for (const step of ["write", "design", "review", "render", "deliver", "proof"]) await artifacts.clear(row.orderId, step);
          await helpers.addJob("deck_step", { orderId: row.orderId, step: "write" }, { jobKey: `${row.orderId}:write`, maxAttempts: 5 });
          helpers.logger.info(`escrow: revision requested for ${row.orderId}, rewriting`);
        }
      } else if (o.status === "Released" && row.state === "delivered") {
        await store.transitionOrder(row.orderId, "delivered", "released");
      }
    } catch (e) {
      helpers.logger.warn(`escrow timer ${row.orderId}: ${(e as Error).message}`);
    }
  }
};

const runner = await run({
  connectionString: need("DATABASE_URL"),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  noHandleSignals: false,
  pollInterval: 1000,
  taskList: { deck_step: deckStep, outbox_drain: outboxDrain, billing_settle: billingSettle, escrow_timers: escrowTimers },
  crontab: ["* * * * * outbox_drain ?jobKey=outbox_drain", "*/5 * * * * billing_settle ?jobKey=billing_settle", "*/10 * * * * escrow_timers ?jobKey=escrow_timers"].join("\n"),
});
console.info("[worker] up: deck_step, outbox_drain, billing_settle, escrow_timers");
await runner.promise;
