// Worker tasks for the content store (ADR 0018): analyse a business, find opportunities. Posts come in step 6.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "graphile-worker";
import sharp from "sharp";
import type { ContentStore, Envelopes } from "@nearchant/db";
import type { ResultEnvelope } from "@nearchant/contracts";
import { assSubtitles, compose } from "./video-compose.js";
import type { Tts } from "./tts.js";
import { block, writeVideoScript, analyzeBusiness, factsFromProfile, findOpportunities, learnTaste, makeAsker, writePostOptions, type OwnerMemory, type AgentEnv, type ModelRouter, type SearchResult, type StyleProfile } from "@nearchant/swarm";

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
  /** The lab's chosen image model on Comfy Cloud (admin "Use in production"); null = the router's image route. */
  labRender?: (prompt: string, photo: Buffer | null) => Promise<Buffer | null>;
  /** Short videos (step 13b): a clip from a picture (Comfy Cloud Wan 2.2), an English voice, fonts for captions. */
  video?: { render: (prompt: string, picture: Buffer) => Promise<Buffer>; tts: Tts; fontsDir: string };
  /** Side effects sent once per key (chain calls). */
  outbox: { enqueue(key: string, kind: string, payload: unknown): Promise<unknown> };
}

export interface PostWriter { model: string; tier: string; reportHash?: string; signingAddress?: string | null }

/** The proof-log entry for a published post: what was published, made by which AI, owned by whom (ADR 0018).
 *  When the text model ran in a NEAR AI TEE, attestation_ref = "nearai:<model>:<report sha256>"; the report itself is
 *  served at /attestations/<sha256>.json. */
export function postProofEntry(p: { id: string; caption: string; imageSha256: string | null; idea: unknown }) {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const { writer, ...idea } = (p.idea ?? {}) as { writer?: PostWriter } & Record<string, unknown>;
  return {
    task_id: `post:${p.id}`, order_id: null, brief_hash: h(JSON.stringify(idea)),
    producer: `nearchant:content-store@0.1.0 (${writer?.model ?? "qwen3.6"} + qwen-image-edit-2511)`.slice(0, 200),
    output_hash: h(`${p.caption}\n${p.imageSha256 ?? ""}`),
    attestation_ref: writer?.reportHash ? `nearai:${writer.model}:${writer.reportHash}`.slice(0, 400) : null,
    review: { passed: true, reviewer_hash: h(p.caption) },
  };
}

/** A photo as a JPEG data URL, at most 1024 px on the long side (vision models bill by pixels). */
export async function photoDataUrl(path: string): Promise<string> {
  const jpg = await sharp(await readFile(path)).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

export function makeContentTasks(d: ContentTaskDeps): Record<string, Task> {
  const askFor = (handle: string, step: string, seen?: (e: ResultEnvelope) => void) => makeAsker(d.env, d.router, async (e) => { seen?.(e); await d.envelopes.add(`content:${handle}:${step}`, step, d.accountOf(handle), e); });

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
    // Which model wrote these posts, and its TEE attestation report when it ran in one (goes into the proof).
    let writer: PostWriter | null = null;
    try {
      drafts = await writePostOptions(askFor(handle, "ideas", (e) => { writer = { model: e.model, tier: e.privacyTier, ...(e.attestation ? { reportHash: e.attestation.reportHash, signingAddress: e.attestation.signingAddress ?? null } : {}) }; }), {
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
      await d.content.updatePost(p.id, { status: "rendering", caption: dr.caption, hashtags: dr.hashtags, idea: { ...dr, ...(writer ? { writer } : {}) }, sourceMediaId: src?.id ?? null });
      let imageMediaId: string | null = null;
      try {
        const prompt = dr.image_prompt || dr.angle;
        const photoB64 = src ? (await photoDataUrl(join(d.mediaDir, src.key))).split(",", 2)[1]! : null;
        let bytes: Buffer | null = d.labRender ? await d.labRender(prompt, photoB64 ? Buffer.from(photoB64, "base64") : null) : null;
        if (!bytes) {
          const input: Record<string, unknown> = { prompt, n: 1, size: "1024x1280" };
          if (photoB64) input.image_b64 = photoB64;
          // Product photos for posts that will be published: public data, so a cloud renderer (Comfy Cloud) may take them.
          const env = await d.router.call({ capability: "image.generate", dataClass: "public", input, timeoutMs: 300_000 });
          await d.envelopes.add(`content:${handle}:render`, "render", d.accountOf(handle), env);
          const b64 = (env.output as { images?: { b64?: string }[] }).images?.[0]?.b64;
          bytes = b64 ? Buffer.from(b64, "base64") : null;
        }
        if (bytes) {
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

  /** A post's video on the public store (a copy; the private original stays). */
  async function publishVideo(handle: string, postId: string, key: string): Promise<string> {
    const pub = `${handle}/public/${postId}.mp4`;
    await mkdir(join(d.mediaDir, handle, "public"), { recursive: true });
    await copyFile(join(d.mediaDir, key), join(d.mediaDir, pub));
    return pub;
  }

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
    const vid = (p.idea as { video?: { status?: string; key?: string } }).video;
    const publicVideo = vid?.status === "ready" && vid.key ? await publishVideo(p.handle, p.id, vid.key) : null;
    await d.content.updatePost(p.id, { status: "published", publishedAt: new Date(), idea: { ...(p.idea as object), publicImage: publicKey, ...(publicVideo ? { publicVideo } : {}) } });
    await d.outbox.enqueue(`proof:post:${p.id}`, "post.proof", { postId: p.id, handle: p.handle, entry: postProofEntry({ id: p.id, caption: p.caption ?? "", imageSha256: m?.sha256 ?? null, idea: p.idea }) });
    d.log(`published ${p.id}`);
  };

  // "What AI noticed": the insight writer reads the store's numbers (never invents any) — Analytics page.
  const writeInsightsTask: Task = async (payload) => {
    const { handle } = payload as { handle: string };
    const [events, sales, posts] = await Promise.all([d.content.eventCounts(handle, 30), d.content.salesSince(handle, 30), d.content.listPosts(handle, { limit: 60 })]);
    const numbers = {
      days: events, sales_30d: { count: sales.count, usdc: Number(sales.units) / 10 ** d.decimals },
      posts: posts.filter((p) => p.publishedAt).map((p) => ({ angle: (p.idea as { angle?: string }).angle ?? "", published: p.publishedAt, has_proof: !!p.proof })),
    };
    const raw = await askFor(handle, "insights")<{ insights?: { text: string; action: string; kind: string }[]; best_time?: string | null; headline?: string }>("insight-writer", block("numbers", numbers));
    await d.content.setSetting(`insights:${handle}`, { insights: (raw.insights ?? []).slice(0, 3), best_time: raw.best_time ?? null, headline: raw.headline ?? "", at: new Date().toISOString() });
    d.log(`insights ${handle}`);
  };

  // A post's short video: script → (clip ‖ voice) → ffmpeg. 3 picture credits, refunded on failure.
  const makeVideoTask: Task = async (payload) => {
    const { postId } = payload as { postId: string };
    const p = await d.content.getPost(postId);
    if (!p || !d.video) return;
    const idea = (p.idea ?? {}) as Record<string, unknown>;
    const setVideo = (v: Record<string, unknown>) => d.content.updatePost(p.id, { idea: { ...idea, video: v } });
    try {
      const mid = p.imageMediaId ?? p.sourceMediaId;
      const m = mid ? await d.content.getMedia(mid) : null;
      if (!m) throw new Error("the post has no picture to animate");
      const profile = (await d.content.getProfile(p.handle))?.data as StyleProfile;
      const script = await writeVideoScript(askFor(p.handle, "video"), { profile, caption: p.caption ?? "", angle: String(idea.angle ?? "") });
      await setVideo({ status: "rendering", script });
      const picture = await sharp(await readFile(join(d.mediaDir, m.key))).rotate().resize(720, 1280, { fit: "cover" }).png().toBuffer();
      const [clip, voice] = await Promise.all([d.video.render(script.video_prompt, picture), d.video.tts.speak(script.voiceover, p.handle)]);
      const dir = join(d.mediaDir, p.handle, "gen", `v-${p.id}`);
      await mkdir(dir, { recursive: true });
      await Promise.all([writeFile(join(dir, "clip.webm"), clip), writeFile(join(dir, "voice.wav"), voice.wav), writeFile(join(dir, "subs.ass"), assSubtitles(script.hook, voice.words))]);
      const key = `${p.handle}/gen/${p.id}.mp4`;
      await compose({ clip: join(dir, "clip.webm"), voice: join(dir, "voice.wav"), ass: join(dir, "subs.ass"), fontsDir: d.video.fontsDir, out: join(d.mediaDir, key), seconds: voice.seconds });
      const bytes = await readFile(join(d.mediaDir, key));
      const mediaId = await d.content.addMedia({ handle: p.handle, kind: "video", key, contentType: "video/mp4", sha256: createHash("sha256").update(bytes).digest("hex") });
      const now = await d.content.getPost(p.id); // published while the video was made → show it on the store too
      const publicVideo = now?.status === "published" ? await publishVideo(p.handle, p.id, key) : undefined;
      await d.content.updatePost(p.id, { idea: { ...((now?.idea ?? idea) as object), video: { status: "ready", mediaId, key, script, seconds: voice.seconds }, ...(publicVideo ? { publicVideo } : {}) } });
      d.log(`video ${p.id}: ${voice.seconds}s, ${Math.round(bytes.length / 1024)} KB`);
    } catch (e) {
      await d.content.refund(p.handle, 0, 3);
      await setVideo({ status: "failed", error: (e as Error).message.slice(0, 300) });
      d.log(`video ${p.id} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  };

  return { make_video: makeVideoTask, write_insights: writeInsightsTask, publish_post: publishPostTask, analyze_business: analyzeBusinessTask, find_opportunities: findOpportunitiesTask, generate_posts: generatePostsTask, learn_taste: learnTasteTask };
}
