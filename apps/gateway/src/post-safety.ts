// The safety check's verdict on a draft (ADR 0022 moderator, check-only): what the post editor shows and what blocks
// publishing. A verdict counts only for the caption and picture it judged.
import { createHash } from "node:crypto";

type PostLike = { caption?: string | null; imageMediaId?: string | null; idea?: unknown };
type Safety = { flagged?: boolean; summary?: string; caption_hash?: string; image?: string | null };

/** The verdict on the post as it is now (same caption and picture), or null when there is none yet. */
export function safetyCurrent(p: PostLike): Safety | null {
  const sf = ((p.idea ?? {}) as { safety?: Safety }).safety;
  if (!sf || sf.caption_hash !== createHash("sha256").update(p.caption ?? "").digest("hex") || (sf.image ?? null) !== (p.imageMediaId ?? null)) return null;
  return sf;
}
/** Why a draft needs a change before it can go public, or null. */
export function safetyFlag(p: PostLike): string | null {
  const sf = safetyCurrent(p);
  return sf?.flagged ? (sf.summary || "the safety check flagged it") : null;
}
