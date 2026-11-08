// Text on a post picture is ours (a headline strip added afterwards), never the image model's: models garble
// lettering and even invent brand labels (a "ZARA" tag on someone's own jacket). So every prompt asks for no text,
// and an optional vision check finds pictures that have some anyway, to draw them again.
import type { Ask } from "./openai-ask.js";

/** Appended to every picture prompt. */
export const NO_TEXT = " No text, letters, words, numbers, logos or watermarks anywhere in the picture.";

const QUESTION = 'Does this picture contain any visible text, letters, words, numbers, brand names, labels or logo-like lettering drawn inside it (garbled or not)? Answer only JSON: {"has_text": true|false}';

/** Asks a vision model whether the picture has lettering. "unknown" when the model failed or answered nonsense —
 *  callers usually keep the picture then (one bad check should not cost a render). */
export async function checkNoText(see: Ask, image: Uint8Array | string): Promise<"clean" | "text" | "unknown"> {
  try {
    const raw = await see({ text: QUESTION, images: [image], maxTokens: 60, temperature: 0 });
    const has = raw && typeof raw === "object" ? (raw as { has_text?: unknown }).has_text : undefined;
    return has === true ? "text" : has === false ? "clean" : "unknown";
  } catch {
    return "unknown";
  }
}
