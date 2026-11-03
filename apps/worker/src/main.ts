import { createHash } from "node:crypto";
// Worker: one graphile-worker task per pipeline step (docs/swarm.md), plus the outbox drain.
// env: DATABASE_URL, NEARCHANT_SECRET_KEY, NEAR_RELAYER_KEY, NEARAI_API_KEY / NC_LOCAL_LLM_KEY (or REPLAY_DIR),
//      SEARXNG_URL?, RENDERER_URL, MEDIA_DIR, MEDIA_PUBLIC
import { join, resolve } from "node:path";
import { makeWorkerUtils, run, type Task } from "graphile-worker";
import { Artifacts, ContentStore, Envelopes, FeedStore, Outbox, PgStore, Sealer, connect, emailHtml, resendMailer, runMigrations, waitWhileFenced } from "@nearchant/db";
import { Chain, loadAccounts } from "@nearchant/near";
import { PIPELINE, hireAgent, loadAgentEnv, runStep, type JobDeps, type Step } from "@nearchant/swarm";
import { agentKey } from "@nearchant/db";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { deliver, type DeliverPayload } from "./deliver.js";
import { buildBatch, leafHash, usageRecord } from "@nearchant/billing";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { ResultEnvelope } from "@nearchant/contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeRouter } from "./router.js";
import { checkNearAiReport } from "@nearchant/providers";
import { makeTts } from "./tts.js";
import { makeContentTasks } from "./content-tasks.js";
import { makeMarketTasks } from "./market-tasks.js";
import { ComfyCloud, fillWorkflow, type LabVariant } from "@nearchant/providers";
import { localMedia, marpServerRender, searxng } from "./tools.js";

// Standby fence (ADR 0020): while the Mac standby serves the site, this node waits instead of using a stale database.
await waitWhileFenced(process.env.FENCE_URL);

const root = resolve(import.meta.dirname, "../../..");
const need = (k: string) => process.env[k] ?? (console.error(`${k} is not set`), process.exit(2));
const gw = parse(readFileSync(join(root, "config/gateway.yaml"), "utf8"));
const accounts = loadAccounts(join(root, "config/defaults/accounts.yaml"), gw.network);
const conn = connect(need("DATABASE_URL"));
await runMigrations(conn.db, conn.sql);
const store = new PgStore(conn.db);
const artifacts = new Artifacts(conn.db);
const envelopes = new Envelopes(conn.db);
const outbox = new Outbox(conn.db);
const sealer = new Sealer(need("NEARCHANT_SECRET_KEY"));
const chain = new Chain({ rpcUrls: gw.rpc_urls, relayer: { accountId: accounts.relayer, secretKey: need("NEAR_RELAYER_KEY") } });
// NEAR AI TEE reports are kept (once each) and served at /attestations/<hash>.json, so a proof that cites one can be checked.
const router = await makeRouter(join(root, "config", process.env.PROVIDERS_FILE ?? "providers.yaml"), {
  onAttestationReport: async (ref, _model, raw) => {
    const dir = join(process.env.MEDIA_DIR ?? join(root, ".media"), "attestations");
    await mkdir(dir, { recursive: true });
    const fresh = await writeFile(join(dir, `${ref.reportHash}.json`), raw, { flag: "wx" }).then(() => true, (e) => { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; });
    // Our own check of the report (nonce, key binding, TDX quote via Phala): published next to it, once.
    if (fresh && ref.nonce) void checkNearAiReport(raw, ref.nonce).then((c) => writeFile(join(dir, `${ref.reportHash}.check.json`), JSON.stringify(c, null, 1)))
      .then(() => console.info(`[attest] report ${ref.reportHash.slice(0, 10)} checked`), (e) => console.warn(`[attest] check failed: ${(e as Error).message}`));
  },
});
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
    if (kind === "item.ship") {
      // The seller shipped a store item: proof of the shipping note, then mark_delivered so the buyer can confirm.
      const p = payload as { orderId: string; handle: string; note: string };
      const h = (x: string) => createHash("sha256").update(x).digest("hex");
      await store.transitionOrder(p.orderId, "paid", "in_progress");
      return deliver({ chain, accounts, db: conn.db, sealer, store, publicUrl: process.env.PUBLIC_URL }, { orderId: p.orderId, handle: p.handle, proof: {
        task_id: `ship:${p.orderId}`, order_id: p.orderId, brief_hash: h(p.orderId), producer: `${p.handle} (shipped by the seller)`,
        output_hash: h(p.note || "shipped"), attestation_ref: null, review: { passed: true, reviewer_hash: h(p.note || "shipped") },
      } as never });
    }
    if (kind === "post.proof") {
      // A published post's proof, signed by the store's own proofs agent key (function-call only).
      const p = payload as { postId: string; handle: string; entry: Record<string, unknown> };
      const post = await contentStore.getPost(p.postId);
      const done = (post?.proof as { proofId?: string } | null)?.proofId;
      if (done) return { proofId: done };
      const key = await agentKey({ db: conn.db, sealer }, p.handle, "proofs-key");
      const proofId = await chain.callAs<string>(`${p.handle}.${accounts.root}`, key, accounts.proofs, "record", { entry: p.entry }, 50);
      await contentStore.updatePost(p.postId, { proof: { proofId, outputHash: p.entry.output_hash, contract: accounts.proofs } });
      return { proofId };
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

const mediaDir = process.env.MEDIA_DIR ?? join(root, ".media");
const contentStore = new ContentStore(conn.db);
// Admin lab choice (settings.image_variant) renders post pictures on Comfy Cloud when a key is set.
const comfy = process.env.COMFY_API_KEY ? new ComfyCloud(process.env.COMFY_API_KEY) : null;
const lab = parse(readFileSync(join(root, "config/image-lab.yaml"), "utf8")) as { variants: LabVariant[] };
const labRender = comfy ? async (prompt: string, photo: Buffer | null): Promise<Buffer | null> => {
  const id = await contentStore.getSetting<string>("image_variant");
  let v = lab.variants.find((x) => x.id === id);
  // A post without a product photo is painted from text: the edit model needs a photo (it renders black without).
  if (v?.needs_photo && !photo) v = lab.variants.find((x) => x.id === (process.env.T2I_VARIANT ?? "qi2512-l4"));
  if (!v || (v.needs_photo && !photo)) return null;
  const template = JSON.parse(readFileSync(join(root, "config/image-lab", v.workflow), "utf8"));
  const ref = photo ? await comfy.upload(photo, `post-${Date.now()}.png`) : undefined;
  const wf = fillWorkflow(template, { prompt, ref, seed: Math.floor(Math.random() * 2 ** 31), width: 1024, height: 1280, set: v.set });
  console.info(`[content] render with lab model ${v.id}`);
  return Buffer.from(await comfy.run(wf));
} : undefined;

// Short videos: the lab's video variant on Comfy Cloud + the English voice service (TTS_URL).
const videoVariant = lab.variants.find((x) => x.id === (process.env.VIDEO_VARIANT ?? "wan22-i2v14b-l4"));
const video = comfy && videoVariant && process.env.TTS_URL ? {
  tts: makeTts(process.env.TTS_URL, process.env.TTS_API_KEY ?? ""),
  fontsDir: process.env.FONTS_DIR ?? join(root, "assets/fonts"),
  // The end-card shows where to buy: <handle>.nearchant.com on the public site, else the /h/<handle> path.
  storeLink: (h: string) => { const u = new URL(process.env.PUBLIC_URL ?? "http://localhost:8787"); return u.protocol === "https:" ? `${h}.${u.host}` : `${u.host}/h/${h}`; },
  render: async (prompt: string, picture: Buffer) => {
    const template = JSON.parse(readFileSync(join(root, "config/image-lab", videoVariant.workflow), "utf8"));
    const ref = await comfy.upload(picture, `video-${Date.now()}.png`);
    console.info(`[content] video with ${videoVariant.id}`);
    return Buffer.from(await comfy.run(fillWorkflow(template, { prompt, ref, seed: Math.floor(Math.random() * 2 ** 31), width: 704, height: 1280, set: videoVariant.set })));
  },
} : undefined;

// Marketplace (ADR 0022): moderator agent, search vectors, store places.
const feedStore = new FeedStore(conn.db);
const workerUtils = await makeWorkerUtils({ connectionString: need("DATABASE_URL") });
const gwEmail = (gw as { email?: { from: string; api_url: string } }).email;
const mailer = gwEmail && process.env.RESEND_API_KEY ? resendMailer({ apiKey: process.env.RESEND_API_KEY, from: gwEmail.from, apiUrl: gwEmail.api_url }) : null;
const contentEnv = loadAgentEnv(join(root, "envs/content-store"));
const market = makeMarketTasks({
  content: contentStore, feed: feedStore, envelopes, router, env: contentEnv, mediaDir, accountOf: (h) => `${h}.${accounts.root}`,
  log: (m) => console.info(`[market] ${m}`), decimals: Number(gw.token?.decimals ?? 6), token: String(gw.token?.symbol ?? "nUSD"),
  ...(mailer ? { weeklyMail: async (handle: string, subject: string, lines: string[], key: string) => {
    const to = await contentStore.getSetting<string>(`emailOf:${handle}`);
    if (!to) return false;
    const url = `${String(gw.public_url ?? "https://nearchant.com")}/app/analytics?d=7`;
    await mailer({ to, subject, text: `${lines.join("\n\n")}\n\n${url}`, html: emailHtml({ title: subject, lines, button: { label: "Open your store", url }, foot: "You get this because your email is linked in Settings. Unlink it there to stop." }), idempotencyKey: key });
    return true;
  } } : {}),
  ...(mailer ? { notify: async (handle: string, subject: string, lines: string[]) => {
    const to = await contentStore.getSetting<string>(`emailOf:${handle}`);
    if (to) await mailer({ to, subject, text: lines.join("\n\n"), html: emailHtml({ title: subject, lines }), idempotencyKey: `notify:${handle}:${createHash("sha256").update(subject + lines.join()).digest("hex").slice(0, 16)}` });
  } } : {}),
});
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms))]);

const contentTasks = makeContentTasks({
  moderateBeforePublish: async (postId) => {
    try { const v = await withTimeout(market.moderate(postId), 120_000); return !!v && (await contentStore.getPost(postId))?.removedAt != null; }
    catch (e) { await workerUtils.addJob("moderate_post", { postId }, { jobKey: `moderate:${postId}`, maxAttempts: 5, runAt: new Date(Date.now() + 60_000) }); throw e; }
  },
  marketNumbers: async (handle) => {
    const b = await contentStore.getBusiness(handle);
    const published = (await contentStore.listPosts(handle, { status: ["published"], limit: 200 })).filter((p) => !p.removedAt);
    const likes = await feedStore.likeCounts(published.map((p) => p.id));
    const qs = (await contentStore.getSetting<{ q: string; owner: boolean }[]>(`questions:${handle}`)) ?? [];
    const found = await feedStore.searchesFor(handle, 30);
    return {
      likes_total: [...likes.values()].reduce((a, n) => a + n, 0), followers: await feedStore.followers(handle),
      searches_that_showed_your_posts_30d: found.count, top_goods_in_those_searches: found.goods,
      what_shoppers_search_in_your_country_30d: await feedStore.demand({ days: 30, country: b?.country ?? null, limit: 8 }),
      shopper_questions: { total: qs.length, unanswered_by_ai: qs.filter((x) => x.owner).length, latest_unanswered: qs.filter((x) => x.owner).slice(0, 3).map((x) => x.q) },
    };
  },
  demand: async (handle) => feedStore.demand({ days: 30, country: (await contentStore.getBusiness(handle))?.country ?? null, limit: 12 }),
  afterPublish: async (postId) => { await workerUtils.addJob("index_post", { postId }, { jobKey: `index:${postId}`, maxAttempts: 5 }); },
  fontsDir: process.env.FONTS_DIR ?? join(root, "assets/fonts"),
  ...(labRender ? { labRender } : {}),
  ...(video ? { video } : {}),
  content: contentStore, envelopes, router, outbox, env: contentEnv, mediaDir,
  accountOf: (h) => `${h}.${accounts.root}`, decimals: Number(gw.token?.decimals ?? 6),
  ...(process.env.SEARXNG_URL ? { search: searxng(process.env.SEARXNG_URL) } : {}),
  log: (m) => console.info(`[content] ${m}`),
});

const runner = await run({
  connectionString: need("DATABASE_URL"),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  noHandleSignals: false,
  pollInterval: 1000,
  taskList: { ...contentTasks, ...market.tasks, deck_step: deckStep, outbox_drain: outboxDrain, billing_settle: billingSettle, escrow_timers: escrowTimers },
  crontab: ["* * * * * outbox_drain ?jobKey=outbox_drain", "*/5 * * * * billing_settle ?jobKey=billing_settle", "*/10 * * * * escrow_timers ?jobKey=escrow_timers", "17 4 * * * feed_backfill ?jobKey=feed_backfill", "0 8 * * 1 weekly_report ?jobKey=weekly_report"].join("\n"),
});
await workerUtils.addJob("feed_backfill", {}, { jobKey: "feed_backfill", maxAttempts: 2 }); // places, vectors, moderation for older content
console.info("[worker] up: write_insights, analyze_business, find_opportunities, generate_posts, learn_taste, deck_step, outbox_drain, billing_settle, escrow_timers");
await runner.promise;
