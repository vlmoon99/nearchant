// Ideas to sell more next month — a trend, a price, a bundle, a channel — each with an honest monthly estimate.
// A trend must rest on a real web result your search returned (or on real shopper searches you pass in); anything
// the model cannot back up is dropped here, in code, not left to the prompt.
import { askJson, type Ask } from "./openai-ask.js";
import { block, obj, RULES, str } from "./text.js";

/** The store's style profile (the store-profile kit makes one); only these keys are read. */
export interface StyleProfile {
  business_name: string;
  summary?: string;
  customers?: string;
  products: { name: string; category?: string; description?: string; photo?: number | null }[];
  [key: string]: unknown;
}

export interface Item { title: string; price: string }
export interface SearchResult { title: string; url: string; snippet: string }
/** Your web search (Brave, Tavily, SearXNG, Google CSE…): query → results. */
export type Search = (query: string) => Promise<SearchResult[]>;
/** What shoppers searched in your marketplace (real demand, anonymous): "empty" = searches that found no store. */
export interface ShopperDemand { goods: string; searches: number; empty: number }

export const OPPORTUNITY_KINDS = ["trend", "price", "upsell", "channel"] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export interface Opportunity {
  kind: OpportunityKind;
  title: string;
  why: string;
  action: string;
  /** A cautious monthly revenue gain in USD: an estimate, not a promise. */
  estimate_usd_month: number;
  confidence: "low" | "medium" | "high";
  /** The URL of the search result it rests on, the demand source, or "profile". */
  source: string;
}

export const OPPORTUNITY_PROMPT = `You are a growth advisor for small online sellers. You get a store's style profile, its items with prices (if
any), and web search results about the market. Find the most useful ways for THIS store to sell more in the next
month. Return ONLY a JSON object:
{"opportunities": [{
  "kind": "trend | price | upsell | channel",
  "title": "short, concrete (max 7 words), e.g. 'Linen is trending in New York'",
  "why": "1-2 sentences with the evidence: cite the search result or the profile fact it comes from",
  "action": "the one thing to do, e.g. 'Post the 3 linen items on Friday evening'",
  "estimate_usd_month": 120,
  "confidence": "low | medium | high",
  "source": "url of the search result it is based on, or 'profile'"
}]}
Give 3 or 4 opportunities, at most one of each kind. "trend": something buyers search for or talk about now that
matches the store's products (only from the search results). "price": only if items have prices — whether a price
is clearly below or above similar offers in the results; never invent competitor prices. "upsell": a bundle or
add-on that buyers of one item are likely to want, from the store's own products. "channel": where the store's
buyers are (Telegram, Instagram, a marketplace) with a reason — a place to SHARE the store's posts and store link.
Buyers always order and pay in the store: never suggest taking orders or payments anywhere else (private
channels, DMs, chats, invite links, direct contact, bank transfer). The estimate is a cautious monthly revenue gain
in USD for a small store (usually 30–300); it is an estimate, not a promise. Skip a kind rather than guess.`;

export interface QueryOptions {
  /** A city or country to anchor the searches ("Lisbon"). */
  place?: string;
  /** For the year in trend queries. Default: now. */
  now?: Date;
  /** Default 3. */
  max?: number;
}

/** Web searches for the market around this store: a trend query for the top two products, a price query for the first. */
export function marketQueries(p: StyleProfile, o: QueryOptions = {}): string[] {
  const place = o.place?.trim() ?? "";
  const year = (o.now ?? new Date()).getFullYear();
  const top = p.products.slice(0, 2).map((x) => x.category || x.name).filter(Boolean);
  const q = top.map((t) => `${t} trend ${year} ${place}`.trim());
  if (top[0]) q.push(`${top[0]} price ${place}`.trim());
  return [...new Set(q)].slice(0, o.max ?? 3);
}

export interface FindInput {
  profile: StyleProfile;
  /** The store's items with prices as shown to buyers ("28 USD"); without them no price idea is kept. */
  items?: Item[];
  /** Without a search, no trend is kept (unless shopper demand is given). */
  search?: Search;
  place?: string;
  demand?: ShopperDemand[];
  now?: Date;
}

export interface FindOptions {
  /** Estimates are clamped to 0…maxEstimate USD/month. Default 1000. */
  maxEstimate?: number;
  /** The `source` a demand-backed trend must cite. Default "shopper-searches". */
  demandSource?: string;
  /** Results kept per query (default 5) and in total (default 12). */
  resultsPerQuery?: number;
  maxResults?: number;
  /** Per search call. Default 15 s; a failed or slow search counts as no results. */
  searchTimeoutMs?: number;
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface FindResult {
  opportunities: Opportunity[];
  /** How many web results the model saw. */
  searched: number;
  /** What was dropped and why (for logs and tests). */
  dropped: { title: string; kind: string; reason: string }[];
}

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_r, reject) => { t = setTimeout(() => reject(new Error(`search timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

/** Runs the market searches, asks the model for ideas and keeps only those backed by evidence. */
export async function findOpportunities(ask: Ask, a: FindInput, o: FindOptions = {}): Promise<FindResult> {
  const items = a.items ?? [];
  const demandSource = o.demandSource ?? "shopper-searches";
  const maxEstimate = o.maxEstimate ?? 1000;
  const demand = (a.demand ?? []).map((d) => ({ goods: str(d.goods, 80), searches: Math.max(0, Math.floor(Number(d.searches) || 0)), empty: Math.max(0, Math.floor(Number(d.empty) || 0)) })).filter((d) => d.goods && d.searches > 0).slice(0, 20);

  const results: SearchResult[] = [];
  if (a.search) {
    for (const q of marketQueries(a.profile, { ...(a.place ? { place: a.place } : {}), ...(a.now ? { now: a.now } : {}) })) {
      const got = await withTimeout(a.search(q), o.searchTimeoutMs ?? 15_000).catch(() => [] as SearchResult[]);
      // Web results are data: keep only well-formed ones, and only real http(s) URLs can back a trend.
      results.push(...(Array.isArray(got) ? got : []).map((r) => ({ title: str(r?.title, 200), url: str(r?.url, 500), snippet: str(r?.snippet, 500) })).filter((r) => isUrl(r.url)).slice(0, o.resultsPerQuery ?? 5));
    }
  }
  const shown = results.slice(0, o.maxResults ?? 12);
  const urls = new Set(shown.map((r) => r.url));

  const user = [
    block("profile", a.profile),
    block("items", items.length ? items : "no prices yet"),
    shown.length ? block("search_results", shown) : demand.length ? "No web results available: a trend may rest only on the shopper searches below." : "No web results available: do not give a trend.",
    demand.length ? `${block("shopper_searches", demand)}\nThese are real searches by shoppers on the marketplace (last 30 days; "empty" = searches that found no store). A trend may rest on them: then set "source" to "${demandSource}" and name the search and its count in "why".` : "",
  ].filter(Boolean).join("\n\n");

  const raw = await askJson(ask, {
    system: `${o.prompt ?? OPPORTUNITY_PROMPT}\n\n${RULES}`,
    user, temperature: o.temperature ?? 0.4, maxTokens: o.maxTokens ?? 2500, ...(o.signal ? { signal: o.signal } : {}),
    validate: (r) => {
      const list = obj(r).opportunities;
      if (!Array.isArray(list)) throw new Error('expected {"opportunities": [...]}');
      return list;
    },
  });

  const dropped: FindResult["dropped"] = [];
  const seen = new Set<string>();
  const opportunities: Opportunity[] = [];
  for (const x of raw.map(obj)) {
    const title = str(x.title, 80), why = str(x.why, 300), kind = String(x.kind);
    const drop = (reason: string) => { dropped.push({ title, kind, reason }); };
    if (!(OPPORTUNITY_KINDS as readonly string[]).includes(kind)) { drop("unknown kind"); continue; }
    if (!title || !why) { drop("no title or evidence"); continue; }
    if (seen.has(kind)) { drop("one idea per kind"); continue; }
    const estimate = typeof x.estimate_usd_month === "number" || typeof x.estimate_usd_month === "string" ? Number(x.estimate_usd_month) : Number.NaN;
    if (!Number.isFinite(estimate)) { drop("no numeric estimate"); continue; }
    const source = str(x.source, 500) || "profile";
    // A trend must rest on a result the search actually returned, or on the shopper searches given.
    if (kind === "trend" && !urls.has(source) && !(source === demandSource && demand.length)) { drop("trend without a real source"); continue; }
    // A price claim needs the store's own prices.
    if (kind === "price" && !items.length) { drop("price idea without the store's prices"); continue; }
    seen.add(kind);
    opportunities.push({
      kind: kind as OpportunityKind, title, why, action: str(x.action, 160),
      estimate_usd_month: Math.max(0, Math.min(maxEstimate, Math.round(estimate))),
      confidence: (["low", "medium", "high"].includes(String(x.confidence)) ? x.confidence : "low") as Opportunity["confidence"],
      source,
    });
  }
  return { opportunities: opportunities.slice(0, 4), searched: shown.length, dropped };
}
