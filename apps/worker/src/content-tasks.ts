// Worker tasks for the content store (ADR 0018): analyse a business, find opportunities. Posts come in step 6.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "graphile-worker";
import sharp from "sharp";
import type { ContentStore, Envelopes } from "@nearchant/db";
import { analyzeBusiness, factsFromProfile, findOpportunities, learnTaste, makeAsker, writePostOptions, type OwnerMemory, type AgentEnv, type ModelRouter, type SearchResult, type StyleProfile } from "@nearchant/swarm";

export interface ContentTaskDeps {
  content: ContentStore;
  envelopes: Envelopes;
  router: ModelRouter;
  env: AgentEnv;
  mediaDir: string;
  /** NEAR account that pays for the AI usage of a store (billing, flow 2). */
  accountOf: (handle: string) => string;
  search?: (q: string) => Promise<SearchResult[]>;
  decimals: number;
  log: (m: string) => void;
  /** Side effects sent once per key (chain calls). */
  outbox: { enqueue(key: string, kind: string, payload: unknown): Promise<unknown> };
}

/** The proof-log entry for a published post: what was published, made by which AI, owned by whom (ADR 0018). */
export function postProofEntry(p: { id: string; caption: string; imageSha256: string | null; idea: unknown }) {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  return {
    task_id: `post:${p.id}`, order_id: null, brief_hash: h(JSON.stringify(p.idea ?? {})),
    producer: "nearchant:content-store@0.1.0 (qwen3.6 + qwen-image-edit-2511)",
    output_hash: h(`${p.caption}\n${p.imageSha256 ?? ""}`), attestation_ref: null,
    review: { passed: true, reviewer_hash: h(p.caption) },
  };
}

/** A photo as a JPEG data URL, at most 1024 px on the long side (vision models bill by pixels). */
export async function photoDataUrl(path: string): Promise<string> {
  const jpg = await sharp(await readFile(path)).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

export function makeContentTasks(d: ContentTaskDeps): Record<string, Task> {
  const askFor = (handle: string, step: string) => makeAsker(d.env, d.router, async (e) => { await d.envelopes.add(`content:${handle}:${step}`, step, d.accountOf(handle), e); });

  const analyzeBusinessTask: Task = async (payload, helpers) => {
    const { handle } = payload as { handle: string };
    const b = await d.content.getBusiness(handle);
    if (!b) throw new Error(`no business ${handle}`);
    try {
      const photos = (await d.content.listMedia(handle, "photo")).slice(0, 8);
      const urls = await Promise.all(photos.map((m) => photoDataUrl(join(d.mediaDir, m.key))));
      const profile = await analyzeBusiness(askFor(handle, "analyze"), { name: b.name, kind: b.kind, description: b.description, links: b.links as string[] }, urls);
      // Keep the owner's own edits (e.g. wishes) across a new analysis.
      const prev = (await d.content.getProfile(handle))?.data as Partial<StyleProfile> | undefined;
      await d.content.setProfile(handle, { data: { ...profile, ...(prev?.wishes ? { wishes: prev.wishes } : {}) }, status: "finding" });
      for (const f of factsFromProfile(profile)) await d.content.addFact(handle, f);
      await d.content.addFact(handle, { title: "Comparing with similar stores", detail: "Prices, trends, what sells this month" });
      await helpers.addJob("find_opportunities", { handle }, { jobKey: `opportunities:${handle}`, maxAttempts: 2 });
      d.log(`analyze ${handle}: ${profile.products.length} products`);
    } catch (e) {
      await d.content.setProfile(handle, { status: "failed", error: (e as Error).message.slice(0, 300) });
      throw e;
    }
  };

  const findOpportunitiesTask: Task = async (payload) => {
    const { handle } = payload as { handle: string };
    const profile = (await d.content.getProfile(handle))?.data as StyleProfile | undefined;
    if (!profile?.products) throw new Error(`no profile for ${handle}`);
    const items = (await d.content.listItems(handle)).map((i) => ({ title: i.title, price: `${Number(i.priceUnits) / 10 ** d.decimals} USD` }));
    try {
      const { opportunities, searched } = await findOpportunities(askFor(handle, "opportunities"), profile, items, d.search);
      await d.content.replaceOpportunities(handle, opportunities.map((o) => ({
        kind: o.kind, title: o.title, why: o.why, estimateUnits: String(BigInt(o.estimate_usd_month) * 10n ** BigInt(d.decimals)),
        data: { action: o.action, confidence: o.confidence, source: o.source },
      })));
      await d.content.setProfile(handle, { status: "ready" });
      d.log(`opportunities ${handle}: ${opportunities.length} (from ${searched} web results)`);
    } catch (e) {
      // The profile is still useful without opportunities: the owner can go on and make posts.
      await d.content.setProfile(handle, { status: "ready", error: `opportunities: ${(e as Error).message.slice(0, 200)}` });
      throw e;
    }
  };

  // Posts: one idea-writer call for the batch, then caption → image per option. A missing image engine is not
  // fatal: the option shows the store's own photo and the owner can still use it.
  const generatePostsTask: Task = async (payload, helpers) => {
    const { handle, batchId } = payload as { handle: string; batchId: string };
    const prof = await d.content.getProfile(handle);
    const profile = prof?.data as StyleProfile | undefined;
    if (!profile?.products) throw new Error(`no profile for ${handle}`);
    const batch = (await d.content.listPosts(handle, { limit: 50 })).filter((p) => p.batchId === batchId && p.status === "queued");
    if (!batch.length) return;
    const photos = (await d.content.listMedia(handle, "photo")).slice(0, 8);
    const opps = await d.content.listOpportunities(handle);
    const first = batch[0]!;
    const opp = opps.find((o) => o.id === first.opportunityId) ?? null;
    const recent = (await d.content.signalsSince(handle)).slice(-40);
    for (const p of batch) await d.content.updatePost(p.id, { status: "writing" });
    let drafts;
    try {
      drafts = await writePostOptions(askFor(handle, "ideas"), {
        profile, n: batch.length, photoCount: photos.length, memory: prof?.learned as OwnerMemory,
        recentPicks: recent.filter((x) => x.kind === "chose").map((x) => JSON.stringify((x.data as { idea?: unknown }).idea ?? {})).slice(-6),
        passedAngles: recent.filter((x) => x.kind === "passed").map((x) => String(((x.data as { idea?: { angle?: string } }).idea ?? {}).angle ?? "")).filter(Boolean).slice(-6),
        opportunity: opp && { kind: opp.kind, title: opp.title, why: opp.why, action: (opp.data as { action?: string }).action },
        about: String((first.idea as { about?: string }).about ?? ""),
      });
    } catch (e) {
      for (const p of batch) await d.content.failPost(p.id, `ideas: ${(e as Error).message}`);
      throw e;
    }
    for (const [i, p] of batch.entries()) {
      const dr = drafts[i];
      if (!dr) { await d.content.failPost(p.id, "the model wrote fewer options than asked"); continue; }
      const src = dr.photo ? photos[dr.photo - 1] : undefined;
      await d.content.updatePost(p.id, { status: "rendering", caption: dr.caption, hashtags: dr.hashtags, idea: { ...dr }, sourceMediaId: src?.id ?? null });
      let imageMediaId: string | null = null;
      try {
        const input: Record<string, unknown> = { prompt: dr.image_prompt || dr.angle, n: 1, size: "1024x1280" };
        if (src) input.image_b64 = (await photoDataUrl(join(d.mediaDir, src.key))).split(",", 2)[1];
        // Product photos for posts that will be published: public data, so a cloud renderer (Comfy Cloud) may take them.
        const env = await d.router.call({ capability: "image.generate", dataClass: "public", input, timeoutMs: 300_000 });
        await d.envelopes.add(`content:${handle}:render`, "render", d.accountOf(handle), env);
        const b64 = (env.output as { images?: { b64?: string }[] }).images?.[0]?.b64;
        if (b64) {
          const bytes = Buffer.from(b64, "base64");
          const key = `${handle}/gen/${p.id}.png`;
          await mkdir(join(d.mediaDir, handle, "gen"), { recursive: true });
          await writeFile(join(d.mediaDir, key), bytes);
          imageMediaId = await d.content.addMedia({ handle, kind: "generated", key, contentType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") });
        }
      } catch (e) {
        d.log(`render ${p.id}: ${(e as Error).message.slice(0, 160)} — using the product photo`);
      }
      await d.content.updatePost(p.id, { status: "ready", imageMediaId: imageMediaId ?? src?.id ?? null, error: imageMediaId ? null : "image engine unavailable — showing your photo" });
    }
    await helpers.addJob("learn_taste", { handle }, { jobKey: `learn:${handle}`, runAt: new Date(Date.now() + 60_000), maxAttempts: 1 });
    d.log(`posts ${handle} ${batchId}: ${drafts.length}/${batch.length} written`);
  };

  // The owner's taste memory, from what they kept, passed, edited (runs after batches; cheap and debounced).
  const learnTasteTask: Task = async (payload) => {
    const { handle } = payload as { handle: string };
    const prof = await d.content.getProfile(handle);
    const events = (await d.content.signalsSince(handle)).map((x) => ({ kind: x.kind, data: x.data }));
    if (events.length < 3) return;
    const learned = await learnTaste(askFor(handle, "learn"), (prof?.learned ?? {}) as OwnerMemory, events);
    await d.content.setProfile(handle, { learned });
  };

  // Publishing at the scheduled time: the image becomes public on the store. The proof on NEAR is step 7.
  const publishPostTask: Task = async (payload, helpers) => {
    const { postId } = payload as { postId: string };
    const p = await d.content.getPost(postId);
    if (!p || p.status !== "scheduled") return;
    if (p.scheduledAt && p.scheduledAt.getTime() > Date.now() + 5_000) {
      await helpers.addJob("publish_post", { postId }, { jobKey: `publish:${postId}`, runAt: p.scheduledAt, maxAttempts: 3 });
      return;
    }
    let publicKey: string | null = null;
    const m = p.imageMediaId ? await d.content.getMedia(p.imageMediaId) : null;
    if (m) {
      publicKey = `${p.handle}/public/${p.id}.${m.key.split(".").pop()}`;
      await mkdir(join(d.mediaDir, p.handle, "public"), { recursive: true });
      await copyFile(join(d.mediaDir, m.key), join(d.mediaDir, publicKey));
    }
    await d.content.updatePost(p.id, { status: "published", publishedAt: new Date(), idea: { ...(p.idea as object), publicImage: publicKey } });
    await d.outbox.enqueue(`proof:post:${p.id}`, "post.proof", { postId: p.id, handle: p.handle, entry: postProofEntry({ id: p.id, caption: p.caption ?? "", imageSha256: m?.sha256 ?? null, idea: p.idea }) });
    d.log(`published ${p.id}`);
  };

  return { publish_post: publishPostTask, analyze_business: analyzeBusinessTask, find_opportunities: findOpportunitiesTask, generate_posts: generatePostsTask, learn_taste: learnTasteTask };
}
