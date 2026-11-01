// The content store's AI steps (ADR 0018): learn a business from its photos, find ways to sell more, write post
// options, learn the owner's taste. Pure functions over an Asker, so tests run on a fake model.
import { createHash } from "node:crypto";
import { block, type Asker, type ModelRouter } from "./agent.js";
import type { SearchResult } from "./steps.js";

export interface BusinessInput { name: string; kind: string; description: string; links: string[] }

export interface StyleProfile {
  business_name: string;
  summary: string;
  customers: string;
  tone: string;
  best_days: string[];
  brand_colors: string[];
  products: { name: string; photo: number | null; description: string; category?: string }[];
  content_pillars: string[];
  visual_style: string;
  best_post_hint?: string;
  avoid: string[];
  wishes?: string;
}

export interface Fact { title: string; detail: string }

export interface OpportunityDraft {
  kind: "trend" | "price" | "upsell" | "channel";
  title: string;
  why: string;
  action: string;
  estimate_usd_month: number;
  confidence: "low" | "medium" | "high";
  source: string;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Normalises whatever the model returned into the profile shape (Boost Content's `profile_shape`). */
export function shapeProfile(raw: unknown, fallbackName: string, photoCount: number): StyleProfile {
  const r = (raw ?? {}) as Record<string, unknown>;
  const products = (Array.isArray(r.products) ? r.products : []).slice(0, 30).map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const photo = Number(o.photo);
    return { name: str(o.name, 80), photo: Number.isInteger(photo) && photo >= 1 && photo <= photoCount ? photo : null, description: str(o.description, 300), ...(o.category ? { category: str(o.category, 40) } : {}) };
  }).filter((p) => p.name);
  return {
    business_name: str(r.business_name, 80) || fallbackName,
    summary: str(r.summary),
    customers: str(r.customers),
    tone: str(r.tone, 120),
    best_days: list(r.best_days).filter((d) => DAYS.includes(d)),
    brand_colors: list(r.brand_colors).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5),
    products,
    content_pillars: list(r.content_pillars).slice(0, 5),
    visual_style: str(r.visual_style),
    ...(r.best_post_hint ? { best_post_hint: str(r.best_post_hint) } : {}),
    avoid: list(r.avoid).slice(0, 8),
  };
}

/** What the "Getting to know you" screen shows once the profile is in. */
export function factsFromProfile(p: StyleProfile): Fact[] {
  const facts: Fact[] = [];
  const cats = [...new Set(p.products.map((x) => (x.category || x.name).toLowerCase()))].slice(0, 4);
  if (p.products.length) facts.push({ title: `Found ${p.products.length} product${p.products.length === 1 ? "" : "s"}`, detail: cats.join(", ") });
  if (p.tone || p.visual_style) facts.push({ title: "Your style", detail: [p.tone, p.visual_style].filter(Boolean).join(" · ").slice(0, 160) });
  if (p.customers) facts.push({ title: "Your buyers", detail: p.customers.slice(0, 160) });
  if (p.best_post_hint) facts.push({ title: "Your best posts", detail: p.best_post_hint.slice(0, 160) });
  else if (p.best_days.length) facts.push({ title: "Best days to post", detail: p.best_days.join(", ") });
  return facts;
}

/** Vision step: description + up to 8 photos → style profile. */
export async function analyzeBusiness(ask: Asker, b: BusinessInput, photos: string[]): Promise<StyleProfile> {
  const used = photos.slice(0, 8);
  const text = [
    block("business", { name: b.name, sells: b.kind, description: b.description, links: b.links }),
    `There are ${used.length} product photos, numbered 1 to ${used.length} in order.`,
  ].join("\n\n");
  const raw = await ask<unknown>("profiler", used.length ? { text, images: used } : text);
  return shapeProfile(raw, b.name, used.length);
}

/** Search queries for the market around this store (trend + price evidence). */
export function marketQueries(p: StyleProfile, place = ""): string[] {
  const top = p.products.slice(0, 2).map((x) => x.category || x.name);
  const q = top.map((t) => `${t} trend ${new Date().getFullYear()} ${place}`.trim());
  if (top[0]) q.push(`${top[0]} price ${place}`.trim());
  return [...new Set(q)].slice(0, 3);
}

/** Opportunities from the profile, items and web results; drops anything without evidence. */
export async function findOpportunities(ask: Asker, p: StyleProfile, items: { title: string; price: string }[], search?: (q: string) => Promise<SearchResult[]>, place = ""): Promise<{ opportunities: OpportunityDraft[]; searched: number }> {
  const results: SearchResult[] = [];
  if (search) for (const q of marketQueries(p, place)) results.push(...(await search(q).catch(() => [])).slice(0, 5));
  const raw = await ask<{ opportunities?: unknown[] }>("opportunity-analyst", [
    block("profile", p), block("items", items.length ? items : "no prices yet"), results.length ? block("search_results", results.slice(0, 12)) : "No web results available: base trends only on the profile and say so.",
  ].join("\n\n"));
  const urls = new Set(results.map((r) => r.url));
  const seen = new Set<string>();
  const opportunities = (raw.opportunities ?? []).map((o) => (o ?? {}) as Record<string, unknown>).map((o): OpportunityDraft => ({
    kind: (["trend", "price", "upsell", "channel"].includes(String(o.kind)) ? o.kind : "trend") as OpportunityDraft["kind"],
    title: str(o.title, 80), why: str(o.why, 300), action: str(o.action, 160),
    estimate_usd_month: Math.max(0, Math.min(1000, Math.round(Number(o.estimate_usd_month) || 0))),
    confidence: (["low", "medium", "high"].includes(String(o.confidence)) ? o.confidence : "low") as OpportunityDraft["confidence"],
    source: str(o.source, 300) || "profile",
  })).filter((o) => {
    if (!o.title || !o.why || seen.has(o.kind)) return false;
    // A trend must rest on a real search result; a price claim needs the store's own prices.
    if (o.kind === "trend" && !urls.has(o.source)) return false;
    if (o.kind === "price" && !items.length) return false;
    seen.add(o.kind);
    return true;
  }).slice(0, 4);
  return { opportunities, searched: results.length };
}

export interface PostDraft {
  angle: string;
  product: string | null;
  photo: number | null;
  audience: string;
  caption: string;
  hashtags: string[];
  image_prompt: string;
 headline: string }

export interface OwnerMemory { likes?: string[]; dislikes?: string[]; topics?: string[]; voice?: string; notes?: string[] }

/** Writes n clearly different post options (Boost Content `ideas` i4), serving the chosen opportunity if any. */
export async function writePostOptions(ask: Asker, a: {
  profile: StyleProfile; n: number; photoCount: number; memory?: OwnerMemory; recentPicks?: string[]; passedAngles?: string[];
  opportunity?: { kind: string; title: string; why: string; action?: string } | null; about?: string; today?: string;
}): Promise<PostDraft[]> {
  const parts = [
    block("style_profile", a.profile),
    `There are ${a.photoCount} product photos, numbered 1 to ${a.photoCount} like the profile's products.`,
    `Write exactly ${a.n} post options.`,
    a.opportunity ? block("opportunity", a.opportunity) : "",
    a.about ? block("owner_request", a.about) : "",
    a.memory && Object.keys(a.memory).length ? block("owner_memory", a.memory) : "",
    a.recentPicks?.length ? block("recent_picks", a.recentPicks) : "",
    a.passedAngles?.length ? block("passed_angles", a.passedAngles) : "",
    `Today is ${a.today ?? new Date().toISOString().slice(0, 10)}.`,
  ].filter(Boolean);
  const raw = await ask<{ posts?: unknown[] }>("idea-writer", parts.join("\n\n"));
  return (raw.posts ?? []).map((p) => (p ?? {}) as Record<string, unknown>).map((p): PostDraft => {
    const photo = Number(p.photo);
    const prompts = Array.isArray(p.image_prompts) ? p.image_prompts.map(String) : [];
    return {
      angle: str(p.angle, 160), product: str(p.product, 80) || null,
      photo: Number.isInteger(photo) && photo >= 1 && photo <= a.photoCount ? photo : null,
      audience: str(p.audience, 160), caption: str(p.caption_en ?? p.caption, 2200),
      hashtags: list(p.hashtags).map((h) => h.replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 10),
      image_prompt: str(p.image_prompt, 600) || prompts[0]?.slice(0, 600) || "",
      headline: str(p.headline, 60).split(/\s+/).slice(0, 5).join(" ").replace(/[.!]+$/, ""),
    };
  }).filter((p) => p.caption).slice(0, a.n);
}

/** A short video says one thing: keep whole sentences while they fit in ~22 words (≈ 8–9 s of speech). */
export function shortVoiceover(text: string, maxWords = 22): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  for (const s of sentences) {
    if (out.join(" ").split(/\s+/).filter(Boolean).length + s.split(/\s+/).length > maxWords && out.length) break;
    out.push(s);
  }
  const joined = out.join(" ");
  const words = joined.split(/\s+/);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ").replace(/[,;:]$/, "") + "." : joined;
}

export const CAMERA_ONLY = "Photorealistic product shot: one slow, steady camera push-in toward the product while soft natural light shifts gently across it. The product and the scene stay exactly as they are; nothing enters the frame — no people, no hands, no text.";

export interface VideoScript { hook: string; voiceover: string; video_prompt: string }

/** A short video's script for one post (advertisment_system short-form director, ported): hook, voiceover, motion. */
export async function writeVideoScript(ask: Asker, a: { profile: StyleProfile; caption: string; angle: string }): Promise<VideoScript> {
  const raw = await ask<Record<string, unknown>>("video-director", [block("style_profile", a.profile), block("post", { angle: a.angle, caption: a.caption })].join("\n\n"));
  // The voice must not read numbers (TTS reads them badly and they are the claims most often made up).
  const voiceover = str(raw.voiceover, 400).replace(/\s*[^.!?]*\d[^.!?]*[.!?]?/g, "").trim();
  const s = { hook: str(raw.hook, 60).split(/\s+/).slice(0, 5).join(" "), voiceover: shortVoiceover(voiceover), video_prompt: str(raw.video_prompt, 600) };
  if (!s.voiceover || !s.video_prompt) throw new Error("video-director: empty voiceover or video prompt");
  // The fast video model ignores negative prompts: a motion that brings people or hands in is replaced.
  if (/\b(hands?|fingers?|arms?|people|person|woman|man|model|someone|touch\w*|holds?|holding|wearing|smooth\w*)\b/i.test(s.video_prompt)) s.video_prompt = CAMERA_ONLY;
  return s;
}

/** Updates the owner's taste memory from their signals (Boost Content `learn` k1). */
export async function learnTaste(ask: Asker, memory: OwnerMemory, events: { kind: string; data: unknown }[]): Promise<OwnerMemory> {
  const raw = await ask<Record<string, unknown>>("learner", [block("current_memory", memory), block("events", events.slice(-60))].join("\n\n"));
  return { likes: list(raw.likes).slice(0, 8), dislikes: list(raw.dislikes).slice(0, 8), topics: list(raw.topics).slice(0, 8), voice: str(raw.voice, 300), notes: list(raw.notes).slice(0, 8) };
}

/** What a caption check found (Levanto Sage on NEAR AI): P(the caption promises something the owner never stated). */
export interface CaptionCheck { invented_offer: number; flagged: boolean; model: string; answer_hash: string; at: string }
export const CAPTION_FLAG_AT = 0.5;

/** Asks the decision model one yes/no question about a caption before it goes live. Only public data is sent: the
 *  caption to be published and what the store page already shows (its description, item names and prices). */
export async function checkCaption(router: ModelRouter, a: { caption: string; storeFacts: string }): Promise<CaptionCheck> {
  const state = `What the store owner states publicly about the store and its items:\n${a.storeFacts.slice(0, 6000)}\n\nA social media caption the AI wrote for this store, about to be published:\n${a.caption.slice(0, 2200)}`;
  const env = await router.call({
    capability: "decide", dataClass: "public", timeoutMs: 30_000,
    input: { state, questions: { invented_offer: { type: "noul", instructions: "Does the caption promise anything the owner did not state: a discount, a sale price, free delivery, a gift, a deadline, limited stock, or a price different from the item's price?" } } },
  });
  const ans = (env.output as { answers?: Record<string, { noul?: number }> }).answers ?? {};
  const p = Number(ans.invented_offer?.noul);
  if (!Number.isFinite(p)) throw new Error("decide: no invented_offer probability in the answer");
  return { invented_offer: Math.round(p * 1e4) / 1e4, flagged: p >= CAPTION_FLAG_AT, model: env.model, answer_hash: createHash("sha256").update(JSON.stringify(ans)).digest("hex"), at: new Date().toISOString() };
}
