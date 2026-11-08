// One moderation check: the model judges, this file validates its answer field by field and decides the action.
// The content is data: it is wrapped in a block the content cannot close, and nothing the model says can pick the
// action directly — only `violation`, `categories` and `confidence`, each checked, feed the thresholds.
import type { Ask } from "./openai-ask.js";
import { KIND_INTRO, OTHER, resolvePolicy, systemPrompt, type Action, type Kind, type Policy } from "./policy.js";

export interface ModerationInput {
  text: string;
  /** A picture: bytes or a data:/https: URL. Needs `see`. */
  image?: Uint8Array | string | null;
  kind: Kind;
  /** Optional facts around it (store name and description, a buyer's report…). Also data. */
  context?: string;
}
export interface ModerationDeps {
  /** Vision model (used when there is an image). */
  see?: Ask;
  /** Text model (used when there is no image; falls back to `see`). */
  ask?: Ask;
  policy?: Policy;
  /** What to do when the model's answer cannot be read. Default "throw" (the caller decides, e.g. check later). */
  onUnreadable?: "throw" | "hold" | "allow";
}
export interface Verdict {
  action: Action;
  categories: string[];
  reason: string;
  confidence: number;
}

export class ModerationError extends Error {
  constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = "ModerationError"; }
}

/** A tagged data block; a closing tag inside the data can't end the block early. */
export function dataBlock(tag: string, text: string): string {
  return `<${tag}>\n${text.replaceAll(`</${tag}>`, `<\\/${tag}>`)}\n</${tag}>`;
}

const unit = (x: unknown) => { const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN; return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };
// eslint-disable-next-line no-control-regex
const clean = (x: unknown, n: number) => (typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Turns a raw model answer into a verdict, or null when it is not a usable answer. Exported for tests. */
export function readVerdict(raw: unknown, kind: Kind, policy: Policy = {}): Verdict | null {
  const p = resolvePolicy(policy);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.violation !== "boolean") return null; // the one field we cannot guess
  const confidence = unit(r.confidence);
  // "categories" (this kit's prompt) or "category" (Nearchant's prompt); unknown names are dropped.
  const named = (Array.isArray(r.categories) ? r.categories : [r.category]).filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase());
  let categories = [...new Set(named.filter((c) => p.categories.includes(c)))];
  const reason = clean(r.reason ?? r.summary, 300);
  if (!r.violation || confidence < p.holdAt) return { action: "allow", categories: r.violation ? categories : [], reason: reason || "fine", confidence };
  if (!categories.length) categories = [OTHER];
  const removable = !p.holdOnly.includes(kind) && confidence >= p.removeAt && categories.some((c) => p.removeCategories.includes(c));
  return { action: removable ? "remove" : "hold", categories, reason: reason || `may break the rules: ${categories.join(", ")}`, confidence };
}

/** Judges one post, item or store profile. Throws ModerationError when the model fails (after the adapter's retries). */
export async function moderate(input: ModerationInput, deps: ModerationDeps): Promise<Verdict> {
  const p = resolvePolicy(deps.policy);
  const model = input.image ? deps.see : (deps.ask ?? deps.see);
  if (!model) throw new ModerationError(input.image ? "an image needs a `see` (vision) function" : "pass `ask` or `see`");
  const text = [KIND_INTRO[input.kind], input.context ? dataBlock("context", input.context.slice(0, 2000)) : "", dataBlock("content", input.text.slice(0, 4000))].filter(Boolean).join("\n\n");
  let raw: unknown;
  try {
    raw = await model({ system: systemPrompt(p), text, ...(input.image ? { images: [input.image] } : {}), temperature: 0, maxTokens: 400 });
  } catch (e) {
    throw new ModerationError(`moderation model failed: ${(e as Error).message}`, e);
  }
  const v = readVerdict(raw, input.kind, deps.policy);
  if (v) return v;
  const mode = deps.onUnreadable ?? "throw";
  if (mode === "throw") throw new ModerationError("the moderation answer could not be read");
  return mode === "hold" ? { action: "hold", categories: [OTHER], reason: "the automatic check could not decide — a person will look", confidence: 0 }
    : { action: "allow", categories: [], reason: "not checked (unreadable answer)", confidence: 0 };
}
