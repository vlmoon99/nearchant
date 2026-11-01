import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PublicKey } from "near-api-js";

/** Minimal Telegram Bot API client (ADR 0011: each seller brings their own bot token). */
export class TelegramApi {
  constructor(private readonly token: string, private readonly fetchFn: typeof fetch = fetch, private readonly base = "https://api.telegram.org") {}

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.base}/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000),
    });
    const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result as T;
  }
}

export interface TgMessage { message_id: number; chat: { id: number; type: string }; from?: { id: number; language_code?: string }; text?: string }
export interface TgUpdate { update_id: number; message?: TgMessage }

/** A random secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` on every webhook call. */
export const newWebhookSecret = () => randomBytes(24).toString("base64url");

export function secretMatches(expected: string, got: string | undefined): boolean {
  if (!got) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

/** Looks like a BotFather token: `<digits>:<35 chars>`. */
export const validBotToken = (t: string) => /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(t);

/**
 * Seller authentication without passwords: the seller's browser signs `message` with its own account key; the
 * caller checks that `publicKey` is a full-access key of the seller account on chain. `message` must name the
 * action and the handle and carry a recent timestamp (replay window 5 minutes).
 */
export function verifySellerSignature(p: { message: string; signature: string; publicKey: string; handle: string; action: string; now?: number }): boolean {
  const m = p.message.match(/^nearchant:(\w[\w-]*):([a-z0-9_-]+):(\d{13})$/);
  if (!m || m[1] !== p.action || m[2] !== p.handle) return false;
  if (Math.abs((p.now ?? Date.now()) - Number(m[3])) > 5 * 60_000) return false;
  try {
    return PublicKey.fromString(p.publicKey).verify(new TextEncoder().encode(p.message), Buffer.from(p.signature, "base64"));
  } catch {
    return false;
  }
}

export interface BotShop {
  handle: string;
  name: string;
  cardUrl: string;
  services: { id: string; title: string; priceDisplay: string; deliveryHours: number }[];
}

/**
 * One incoming update → at most one reply. `/start` shows the card and services with order links; anything else
 * goes to the buyer-chat agent (catalog prices only). Messages are data: they never change prices or links.
 */
export async function handleUpdate(api: TelegramApi, shop: BotShop, u: TgUpdate, chat: (text: string) => Promise<string>): Promise<void> {
  const m = u.message;
  if (!m?.text || m.chat.type !== "private") return;
  const text = m.text.slice(0, 2000);
  const keyboard = { inline_keyboard: shop.services.map((s) => [{ text: `Order: ${s.title} — ${s.priceDisplay}`, url: shop.cardUrl }]) };
  if (text.startsWith("/start")) {
    const lines = [`${shop.name}`, ...shop.services.map((s) => `• ${s.title} — ${s.priceDisplay}, delivered in ${s.deliveryHours} h`), "", "Ask me anything, or tap a button to order (free test money on NEAR testnet)."];
    await api.call("sendMessage", { chat_id: m.chat.id, text: lines.join("\n"), reply_markup: keyboard });
    return;
  }
  let answer: string;
  try {
    answer = (await chat(text)).slice(0, 1500) || "Sorry, I couldn't answer that.";
  } catch {
    answer = "Sorry, I can't answer right now. You can still order with the button below.";
  }
  await api.call("sendMessage", { chat_id: m.chat.id, text: answer, reply_markup: keyboard });
}
