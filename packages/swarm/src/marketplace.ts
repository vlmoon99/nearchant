// Marketplace agents (ADR 0022): the moderator, the search planner and the place finder. Every answer is checked
// field by field; anything outside the allowed values becomes the safe default.
import { block, type Asker } from "./agent.js";

export const MOD_CATEGORIES = ["ok", "scam", "illegal", "sexual", "violence", "hate", "counterfeit", "spam"] as const;
export type ModCategory = (typeof MOD_CATEGORIES)[number];
export interface ModVerdict { violation: boolean; category: ModCategory; confidence: number; summary: string; model?: string; at: string }
/** Remove at once from this confidence on (owner's decision: no waiting for a human). */
export const REMOVE_AT = 0.6;

const clip = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
const unit = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

/** Judges one post (picture + text). `report` is the buyer's complaint, if any — data, not proof. */
export async function moderatePost(ask: Asker, a: { caption: string; hashtags: string[]; store: string; storeDescription: string; image?: string | null; report?: { reason: string; note: string } | null }): Promise<ModVerdict> {
  const text = [block("store", { name: a.store, description: a.storeDescription.slice(0, 1500) }), block("post", { caption: a.caption.slice(0, 2500), hashtags: a.hashtags.slice(0, 30) }),
    a.report ? block("buyer_report", { reason: a.report.reason, note: a.report.note.slice(0, 500) }) : ""].filter(Boolean).join("\n\n");
  const raw = await ask<Record<string, unknown>>("moderator", a.image ? { text, images: [a.image] } : text);
  const category = (MOD_CATEGORIES as readonly string[]).includes(String(raw.category)) ? (raw.category as ModCategory) : "ok";
  const violation = raw.violation === true && category !== "ok";
  return { violation, category: violation ? category : "ok", confidence: unit(raw.confidence), summary: clip(raw.summary, 300) || (violation ? category : "fine"), at: new Date().toISOString() };
}
export const shouldRemove = (v: ModVerdict) => v.violation && v.confidence >= REMOVE_AT;

export interface SearchPlan { goods: string[]; terms: string[]; city: string | null; country: string | null; summary: string }
export async function planSearch(ask: Asker, query: string): Promise<SearchPlan> {
  const raw = await ask<Record<string, unknown>>("search-planner", block("search", query.slice(0, 300)));
  const list = (x: unknown, n: number, len: number) => (Array.isArray(x) ? x.map((y) => clip(y, len).toLowerCase()).filter(Boolean).slice(0, n) : []);
  const country = clip(raw.country, 3).toUpperCase();
  return { goods: list(raw.goods, 8, 60), terms: [...new Set(list(raw.terms, 24, 40))], city: clip(raw.city, 60) || null, country: /^[A-Z]{2}$/.test(country) ? country : null, summary: clip(raw.summary, 100) };
}

export interface StorePlace { city: string | null; country: string | null; ships: "local" | "country" | "world" | null }
export async function findPlace(ask: Asker, a: { name: string; description: string; summary?: string; links?: string[] }): Promise<StorePlace> {
  const raw = await ask<Record<string, unknown>>("place-finder", block("store", { name: a.name, description: a.description.slice(0, 2000), summary: (a.summary ?? "").slice(0, 1500), links: (a.links ?? []).slice(0, 5) }));
  const country = clip(raw.country, 3).toUpperCase();
  const ships = ["local", "country", "world"].includes(String(raw.ships)) ? (raw.ships as StorePlace["ships"]) : null;
  return { city: clip(raw.city, 60) || null, country: /^[A-Z]{2}$/.test(country) ? country : null, ships };
}
