// Strikes: each removal counts against the seller; after SUSPEND_AFTER removals the store is suspended (Nearchant
// pauses it and emails the owner). A strike is keyed by what was removed, so checking the same post twice never
// counts twice.
import type { Verdict } from "./moderate.js";

export const SUSPEND_AFTER = 3;

export interface StrikeStore {
  /** Adds a strike once per key; returns the subject's total. */
  add(subject: string, key: string, info: { categories: string[]; reason: string; at: string }): Promise<number>;
  count(subject: string): Promise<number>;
}
export class MemoryStrikeStore implements StrikeStore {
  private m = new Map<string, Map<string, unknown>>();
  async add(subject: string, key: string, info: { categories: string[]; reason: string; at: string }) {
    const s = this.m.get(subject) ?? new Map<string, unknown>();
    if (!s.has(key)) s.set(key, info);
    this.m.set(subject, s);
    return s.size;
  }
  async count(subject: string) { return this.m.get(subject)?.size ?? 0; }
}

/** Records a strike when the verdict counts (default: "remove" only — a hold is our own check, not a punishment). */
export async function recordStrike(store: StrikeStore, subject: string, key: string, v: Verdict, o: { suspendAfter?: number; counts?: Verdict["action"][] } = {}): Promise<{ counted: boolean; count: number; suspend: boolean }> {
  const after = o.suspendAfter ?? SUSPEND_AFTER;
  if (!(o.counts ?? ["remove"]).includes(v.action)) { const count = await store.count(subject); return { counted: false, count, suspend: count >= after }; }
  const count = await store.add(subject, key, { categories: v.categories, reason: v.reason, at: new Date().toISOString() });
  return { counted: true, count, suspend: count >= after };
}
