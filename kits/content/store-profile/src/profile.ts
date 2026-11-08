// Learn a store from its photos and a short description: one vision call → a validated style profile → facts.
import { askJson, type Ask } from "./openai-ask.js";
import { block, list, obj, RULES, str } from "./text.js";

export interface StoreInput {
  /** The store's name; when empty the model takes it from the description or photos. */
  name?: string;
  /** What it sells, in a few words ("handmade candles", "haircuts"). */
  kind?: string;
  description: string;
  /** The store's own links (site, Instagram); passed as text, not fetched. */
  links?: string[];
}

export interface Product {
  name: string;
  /** 1-based number of the photo that shows it, or null. */
  photo: number | null;
  description: string;
  category?: string;
}

export interface StyleProfile {
  business_name: string;
  summary: string;
  customers: string;
  tone: string;
  best_days: string[];
  brand_colors: string[];
  products: Product[];
  content_pillars: string[];
  visual_style: string;
  best_post_hint?: string;
  avoid: string[];
  /** The owner's own wishes for posts and pictures (set by the owner, never by the model). */
  wishes?: string;
}

export interface Fact { title: string; detail: string }

export const PROFILER_PROMPT = `You are a senior social-media strategist. You study a small business from its own description, the kind of
things it sells and its product photos, and write a compact style profile that a copywriter and a photographer
will follow. Write in English. Return ONLY a JSON object with exactly these keys:
{
  "business_name": "the name given; if none is given, the name stated in the description or visible in the photos, else a fitting name of 2 to 4 words",
  "summary": "one sentence: what the business sells and to whom",
  "customers": "who buys, with age range and situation (one string)",
  "tone": "3-6 words describing the voice (one string)",
  "best_days": ["English day names (Monday ... Sunday) when posts work best for this business"],
  "brand_colors": ["#rrggbb", "... 2 to 5 hex colors seen in the photos or implied by the brand"],
  "products": [{"name": "short product name", "photo": 1, "description": "what is visible in that photo", "category": "one or two words"}],
  "content_pillars": ["3 to 5 recurring post themes"],
  "visual_style": "lighting, backgrounds and mood that suit the photos",
  "best_post_hint": "one sentence: what kind of picture of these products would get the most saves, from what is visible",
  "avoid": ["things the posts must not do"]
}
"photo" is the 1-based number of the photo that shows the product, or null. Use only what the description and
photos support; never invent prices, addresses or awards.`;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Normalises whatever the model returned into a StyleProfile: unknown keys dropped, lengths capped, photo numbers
 *  checked against the photos sent, day names and hex colours validated. Never throws. */
export function shapeProfile(raw: unknown, fallbackName: string, photoCount: number): StyleProfile {
  const r = obj(raw);
  const products = (Array.isArray(r.products) ? r.products : []).slice(0, 30).map((p): Product => {
    const o = obj(p);
    const photo = Number(o.photo);
    const category = str(o.category, 40);
    return {
      name: str(o.name, 80),
      photo: o.photo !== null && Number.isInteger(photo) && photo >= 1 && photo <= photoCount ? photo : null,
      description: str(o.description, 300),
      ...(category ? { category } : {}),
    };
  }).filter((p) => p.name);
  const hint = str(r.best_post_hint);
  return {
    business_name: str(r.business_name, 80) || fallbackName,
    summary: str(r.summary),
    customers: str(r.customers),
    tone: str(r.tone, 120),
    best_days: [...new Set(list(r.best_days).filter((d) => DAYS.includes(d)))],
    brand_colors: list(r.brand_colors).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5),
    products,
    content_pillars: list(r.content_pillars).slice(0, 5),
    visual_style: str(r.visual_style),
    ...(hint ? { best_post_hint: hint } : {}),
    avoid: list(r.avoid).slice(0, 8),
  };
}

/** Short, human facts about what was learned ("Found 3 products", "Your style", ...) for an onboarding screen. */
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

export interface AnalyzeOptions {
  /** Photos beyond this are not sent (cost and context). Default 8. */
  maxPhotos?: number;
  /** Replace the built-in prompt (the shared rules are still appended). */
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StoreProfileResult { profile: StyleProfile; facts: Fact[]; photosUsed: number }

/** Photos (data: or https: URLs) + a short description → a validated style profile and its facts. */
export async function analyzeStore(ask: Ask, store: StoreInput, photos: string[] = [], o: AnalyzeOptions = {}): Promise<StoreProfileResult> {
  const used = photos.filter((p) => typeof p === "string" && /^(data:image\/|https?:\/\/)/.test(p)).slice(0, o.maxPhotos ?? 8);
  const text = [
    block("business", { name: store.name ?? "", sells: store.kind ?? "", description: store.description, links: store.links ?? [] }),
    used.length ? `There are ${used.length} product photos, numbered 1 to ${used.length} in order.` : "There are no photos: work from the description only and set every \"photo\" to null.",
  ].join("\n\n");
  const fallback = store.name?.trim() || "My store";
  const profile = await askJson(ask, {
    system: `${o.prompt ?? PROFILER_PROMPT}\n\n${RULES}`,
    user: used.length ? { text, images: used } : text,
    temperature: o.temperature ?? 0.3,
    maxTokens: o.maxTokens ?? 3000,
    ...(o.signal ? { signal: o.signal } : {}),
    validate: (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a JSON object");
      const p = shapeProfile(raw, fallback, used.length);
      // A profile with none of these is useless downstream: ask again rather than store an empty one.
      if (!p.summary && !p.products.length && !p.tone) throw new Error("the profile has no summary, products or tone");
      return p;
    },
  });
  return { profile, facts: factsFromProfile(profile), photosUsed: used.length };
}
