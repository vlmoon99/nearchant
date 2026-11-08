// Write posts in the store's voice: options, rewrites, the owner's taste memory, short-video scripts.
import { askJson, type Ask } from "./openai-ask.js";
import { CAPTION_EDITOR_PROMPT, POST_WRITER_PROMPT, STORE_CTA_RULE, TASTE_LEARNER_PROMPT, VIDEO_DIRECTOR_PROMPT } from "./prompts.js";
import { block, list, obj, RULES, str } from "./text.js";

/** The store's style profile (the store-profile kit makes one; any object with these keys works). */
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
  /** The owner's own wishes for posts and pictures; they outweigh the rest of the profile. */
  wishes?: string;
}

/** What the owner likes, learned from their picks, passes and rewrites (see learnTaste). */
export interface OwnerMemory { likes?: string[]; dislikes?: string[]; topics?: string[]; voice?: string; notes?: string[] }

/** An idea to serve (e.g. from the sales-ideas kit). */
export interface Opportunity { kind: string; title: string; why: string; action?: string }

export interface PostDraft {
  angle: string;
  product: string | null;
  /** 1-based photo number to restyle, or null. */
  photo: number | null;
  audience: string;
  caption: string;
  hashtags: string[];
  /** For an image editor (restyle the photo) or generator; no text in the picture. */
  image_prompt: string;
  /** 2–5 words to print on the picture. */
  headline: string;
}

/** Common call options: replace the prompt, the call-to-action rule, or the model settings. */
export interface CallOptions {
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

const sig = (o: CallOptions) => (o.signal ? { signal: o.signal } : {});

export interface WritePostsInput {
  profile: StyleProfile;
  /** How many options to write. Default 3, at most 10. */
  n?: number;
  /** How many product photos the owner has (numbered like the profile's products). Default: the highest photo number in the profile. */
  photoCount?: number;
  memory?: OwnerMemory;
  /** Angles or captions of options the owner kept recently. */
  recentPicks?: string[];
  /** Angles the owner passed on: never repeated. */
  passedAngles?: string[];
  opportunity?: Opportunity | null;
  /** The owner's own request for this batch ("posts for Mother's Day"). Data, not instructions. */
  about?: string;
  /** YYYY-MM-DD; default today. */
  today?: string;
}

/** Writes n clearly different post options in the store's voice, serving the opportunity if one is given. */
export async function writePostOptions(ask: Ask, a: WritePostsInput, o: CallOptions & { ctaRule?: string } = {}): Promise<PostDraft[]> {
  const n = Math.max(1, Math.min(10, Math.floor(a.n ?? 3)));
  const photoCount = a.photoCount ?? Math.max(0, ...a.profile.products.map((p) => p.photo ?? 0));
  const memory = a.memory && Object.values(a.memory).some((v) => (Array.isArray(v) ? v.length : v)) ? a.memory : null;
  const user = [
    block("style_profile", a.profile),
    photoCount ? `There are ${photoCount} product photos, numbered 1 to ${photoCount} like the profile's products.` : "There are no product photos: set every \"photo\" to null.",
    `Write exactly ${n} post options.`,
    a.opportunity ? block("opportunity", a.opportunity) : "",
    a.about ? block("owner_request", a.about.slice(0, 500)) : "",
    memory ? block("owner_memory", memory) : "",
    a.recentPicks?.length ? block("recent_picks", a.recentPicks.slice(-20)) : "",
    a.passedAngles?.length ? block("passed_angles", a.passedAngles.slice(-20)) : "",
    `Today is ${a.today ?? new Date().toISOString().slice(0, 10)}.`,
  ].filter(Boolean).join("\n\n");
  const cta = o.ctaRule ?? STORE_CTA_RULE;
  return askJson(ask, {
    system: [o.prompt ?? POST_WRITER_PROMPT, cta, RULES].filter(Boolean).join("\n\n"),
    user, temperature: o.temperature ?? 0.8, maxTokens: o.maxTokens ?? 4000, ...sig(o),
    validate: (raw) => {
      const posts = shapePosts(obj(raw).posts, photoCount).slice(0, n);
      if (!posts.length) throw new Error('expected {"posts": [...]} with at least one caption');
      return posts;
    },
  });
}

/** Normalises the model's posts: captions required, photo numbers checked, hashtags cleaned, headline ≤ 5 words. */
export function shapePosts(raw: unknown, photoCount: number): PostDraft[] {
  return (Array.isArray(raw) ? raw : []).map(obj).map((p): PostDraft => {
    const photo = Number(p.photo);
    const prompts = list(p.image_prompts);
    return {
      angle: str(p.angle, 160),
      product: str(p.product, 80) || null,
      photo: p.photo !== null && Number.isInteger(photo) && photo >= 1 && photo <= photoCount ? photo : null,
      audience: str(p.audience, 160),
      caption: str(p.caption ?? p.caption_en, 2200),
      hashtags: [...new Set(list(p.hashtags).map((h) => h.replace(/^#+/, "").replace(/\s+/g, "")).filter(Boolean))].slice(0, 10),
      image_prompt: str(p.image_prompt, 600) || prompts[0]?.slice(0, 600) || "",
      headline: str(p.headline, 60).split(/\s+/).slice(0, 5).join(" ").replace(/[.!]+$/, ""),
    };
  }).filter((p) => p.caption);
}

export const CAPTION_STYLES = ["shorter", "playful", "bolder", "custom", "fix"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export interface RewriteInput {
  profile: StyleProfile;
  caption: string;
  style: CaptionStyle;
  /** "custom": the owner's wish for this caption; "fix": why a check flagged it (e.g. the caption-check kit). */
  instruction?: string;
}

/** Rewrites a caption in one style; facts kept, nothing added. Instructions go in as data blocks. */
export async function rewriteCaption(ask: Ask, a: RewriteInput, o: CallOptions = {}): Promise<string> {
  if (!CAPTION_STYLES.includes(a.style)) throw new Error(`unknown caption style "${String(a.style)}"`);
  if (!a.caption.trim()) throw new Error("nothing to rewrite: the caption is empty");
  const extra = a.style === "custom" && a.instruction ? [block("owner_instruction", a.instruction.slice(0, 300))]
    : a.style === "fix" && a.instruction ? [block("flagged_because", a.instruction.slice(0, 300))] : [];
  return askJson(ask, {
    system: `${o.prompt ?? CAPTION_EDITOR_PROMPT}\n\n${STORE_CTA_RULE}\n\n${RULES}`,
    user: [block("style_profile", a.profile), block("caption", a.caption.slice(0, 2200)), `Style: ${a.style}`, ...extra].join("\n\n"),
    temperature: o.temperature ?? 0.7, maxTokens: o.maxTokens ?? 1200, ...sig(o),
    validate: (raw) => {
      const out = str(obj(raw).caption, 2200);
      if (!out) throw new Error('expected {"caption": "..."} with text');
      return out;
    },
  });
}

/** One thing the owner did: { kind: "picked" | "passed" | "rewrote" | "scheduled" | "deleted" | …, data }. */
export interface TasteEvent { kind: string; data: unknown }

/** Updates the owner's taste memory from their latest signals (the last `maxEvents`, default 60). */
export async function learnTaste(ask: Ask, memory: OwnerMemory, events: TasteEvent[], o: CallOptions & { maxEvents?: number } = {}): Promise<OwnerMemory> {
  if (!events.length) return memory;
  return askJson(ask, {
    system: `${o.prompt ?? TASTE_LEARNER_PROMPT}\n\n${RULES}`,
    user: [block("current_memory", memory), block("events", events.slice(-(o.maxEvents ?? 60)))].join("\n\n"),
    temperature: o.temperature ?? 0.2, maxTokens: o.maxTokens ?? 1500, ...sig(o),
    validate: (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
      const r = raw as Record<string, unknown>;
      return { likes: list(r.likes).slice(0, 8), dislikes: list(r.dislikes).slice(0, 8), topics: list(r.topics).slice(0, 8), voice: str(r.voice, 300), notes: list(r.notes).slice(0, 8) };
    },
  });
}

/** A short video says one thing: keep whole sentences while they fit in `maxWords` (22 ≈ 8–9 s of speech). */
export function shortVoiceover(text: string, maxWords = 22): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  for (const s of sentences) {
    if (out.length && out.join(" ").split(/\s+/).filter(Boolean).length + s.split(/\s+/).length > maxWords) break;
    out.push(s);
  }
  const joined = out.join(" ");
  const words = joined.split(/\s+/).filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(" ").replace(/[,;:]$/, "") + "." : joined;
}

/** Used when the model's motion would bring people or hands into the frame (fast video models ignore negatives). */
export const CAMERA_ONLY = "Photorealistic product shot: one slow, steady camera push-in toward the product while soft natural light shifts gently across it. The product and the scene stay exactly as they are; nothing enters the frame — no people, no hands, no text.";

export interface VideoScript { hook: string; voiceover: string; video_prompt: string }

/** A 6–10 s vertical video's script for one post: on-screen hook, a short voiceover, a camera-only motion prompt. */
export async function writeVideoScript(ask: Ask, a: { profile: StyleProfile; caption: string; angle?: string }, o: CallOptions & { maxWords?: number } = {}): Promise<VideoScript> {
  return askJson(ask, {
    system: `${o.prompt ?? VIDEO_DIRECTOR_PROMPT}\n\n${RULES}`,
    user: [block("style_profile", a.profile), block("post", { angle: a.angle ?? "", caption: a.caption })].join("\n\n"),
    temperature: o.temperature ?? 0.7, maxTokens: o.maxTokens ?? 3000, ...sig(o),
    validate: (raw) => {
      const r = obj(raw);
      // The voice must not read numbers: TTS reads them badly and they are the claims most often made up.
      const spoken = str(r.voiceover, 400).replace(/\s*[^.!?]*\d[^.!?]*[.!?]?/g, "").trim();
      const s: VideoScript = { hook: str(r.hook, 60).split(/\s+/).slice(0, 5).join(" "), voiceover: shortVoiceover(spoken, o.maxWords), video_prompt: str(r.video_prompt, 600) };
      if (!s.voiceover || !s.video_prompt) throw new Error("empty voiceover (numbers are removed) or video prompt");
      if (/\b(hands?|fingers?|arms?|people|person|woman|man|model|someone|touch\w*|holds?|holding|wearing|smooth\w*)\b/i.test(s.video_prompt)) s.video_prompt = CAMERA_ONLY;
      return s;
    },
  });
}
