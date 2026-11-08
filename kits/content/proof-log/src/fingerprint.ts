import { createHash } from "node:crypto";

/** What `record` sends; mirrors the contract's `NewEntry`. */
export interface NewEntry {
  /** sha256 hex of the content (or of its parts, see `fingerprint`). */
  content_hash: string;
  /** Who or what made it, e.g. `model:qwen3` or `my-app@1.2 (gpt-4o + flux)` (≤ 200 chars). */
  producer: string | null;
  /** What it is about, e.g. `post:123` or an order id (≤ 128 chars). */
  subject: string | null;
  /** A review/check result, if there was one. `false` makes the contract's `is_passed` false. */
  passed: boolean | null;
  /** Free-form JSON string (≤ 2048 bytes). */
  metadata: string | null;
}

export type Content = string | Uint8Array;

export interface FingerprintMeta {
  producer?: string;
  subject?: string;
  passed?: boolean;
  /** When it was made (your clock; the chain adds its own block time). Stored in metadata as ISO. */
  madeAt?: Date | string;
  /** Anything else worth keeping, as JSON. Never put secrets or personal data here: the log is public forever. */
  metadata?: Record<string, unknown>;
}

export const sha256 = (c: Content): string => createHash("sha256").update(c).digest("hex");

/**
 * Builds a log entry for some content. Pass one value (a file, a caption, an AI answer) or named parts
 * (`{ caption, image }`): with parts, each part's sha256 is kept in metadata, so later you can prove the caption alone,
 * and `content_hash` is the sha256 of the sorted `name:hash` lines.
 */
export function fingerprint(content: Content | Record<string, Content>, meta: FingerprintMeta = {}): NewEntry {
  let contentHash: string;
  let parts: Record<string, string> | undefined;
  if (typeof content === "string" || content instanceof Uint8Array) {
    contentHash = sha256(content);
  } else {
    const names = Object.keys(content).sort();
    if (!names.length) throw new Error("fingerprint: no parts given");
    parts = Object.fromEntries(names.map((n) => [n, sha256(content[n]!)]));
    contentHash = partsHash(parts);
  }
  const madeAt = meta.madeAt instanceof Date ? meta.madeAt.toISOString() : meta.madeAt;
  const md = { ...(meta.metadata ?? {}), ...(parts ? { parts } : {}), ...(madeAt ? { made_at: madeAt } : {}) };
  const metadata = Object.keys(md).length ? JSON.stringify(md) : null;
  if (metadata && Buffer.byteLength(metadata) > 2048) throw new Error("fingerprint: metadata is over 2048 bytes");
  if (meta.producer && meta.producer.length > 200) throw new Error("fingerprint: producer is over 200 chars");
  if (meta.subject && meta.subject.length > 128) throw new Error("fingerprint: subject is over 128 chars");
  return { content_hash: contentHash, producer: meta.producer ?? null, subject: meta.subject ?? null, passed: meta.passed ?? null, metadata };
}

/** The combined hash of named part hashes: sha256 of `name:hash` lines, sorted by name. */
export function partsHash(parts: Record<string, string>): string {
  return sha256(Object.keys(parts).sort().map((n) => `${n}:${parts[n]}`).join("\n"));
}

/** Does this content match an entry's fingerprint? Pass the same shape you fingerprinted (one value or named parts). */
export function matches(content: Content | Record<string, Content>, entry: { content_hash: string }): boolean {
  return fingerprint(content).content_hash === entry.content_hash;
}
