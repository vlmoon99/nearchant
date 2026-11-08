// Re-check only what changed: a fingerprint of what the check reads (title, description, photo). Saving the same
// text again keeps the earlier verdict — no new model call, and a held item stays held until it is fixed.
import { createHash } from "node:crypto";
import { moderate, type ModerationDeps, type Verdict } from "./moderate.js";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** sha256 of `title\ndescription\nphoto`. `photo` is an id/URL string, or bytes (hashed first). */
export function checkHash(i: { title: string; description: string; photo?: string | Uint8Array | null }): string {
  const photo = i.photo == null ? "" : typeof i.photo === "string" ? i.photo : sha(i.photo);
  return sha(`${i.title}\n${i.description}\n${photo}`);
}

export interface StoredVerdict { hash: string; verdict: Verdict; at: string }
/** Where verdicts are kept, per item id. Swap for your database. */
export interface VerdictStore {
  get(id: string): Promise<StoredVerdict | null>;
  set(id: string, v: StoredVerdict): Promise<void>;
}
export class MemoryVerdictStore implements VerdictStore {
  private m = new Map<string, StoredVerdict>();
  async get(id: string) { return this.m.get(id) ?? null; }
  async set(id: string, v: StoredVerdict) { this.m.set(id, v); }
}

export interface ItemToCheck {
  id: string;
  title: string;
  description: string;
  /** Bytes or a data:/https: URL; also part of the fingerprint. */
  photo?: Uint8Array | string | null;
  /** Context for the model (store name and description). */
  context?: string;
}

/** Moderates an item unless its fingerprint matches the stored verdict. Items are held, never removed (by default). */
export async function moderateItem(item: ItemToCheck, deps: ModerationDeps & { store: VerdictStore }): Promise<{ verdict: Verdict; cached: boolean }> {
  const hash = checkHash(item);
  const seen = await deps.store.get(item.id);
  if (seen?.hash === hash) return { verdict: seen.verdict, cached: true };
  const verdict = await moderate({ kind: "item", text: `${item.title}\n${item.description}`, image: item.photo ?? null, ...(item.context ? { context: item.context } : {}) }, deps);
  await deps.store.set(item.id, { hash, verdict, at: new Date().toISOString() });
  return { verdict, cached: false };
}
