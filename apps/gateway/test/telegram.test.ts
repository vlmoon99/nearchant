import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { TelegramApi, bodyHash, handleUpdate, secretMatches, validBotToken, verifySellerSignature } from "../src/telegram.js";

function fakeTelegram() {
  const sent: any[] = [];
  const fetchFn = (async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }) as unknown as typeof fetch;
  return { api: new TelegramApi("123456:" + "a".repeat(35), fetchFn, "https://tg.test"), sent };
}

const shop = { handle: "alice", name: "Alice Decks", cardUrl: "https://alice.nearchant.com/", services: [{ id: "deck", title: "Pitch deck", priceDisplay: "5 nUSD", deliveryHours: 1 }] };
const msg = (text: string, type = "private") => ({ update_id: 1, message: { message_id: 1, chat: { id: 42, type }, text } });

describe("telegram bot", () => {
  it("/start shows the catalog with order buttons", async () => {
    const { api, sent } = fakeTelegram();
    await handleUpdate(api, shop, msg("/start"), async () => "unused");
    expect(sent[0].chat_id).toBe(42);
    expect(sent[0].text).toContain("Pitch deck — 5 nUSD");
    expect(sent[0].reply_markup.inline_keyboard[0][0].url).toBe("https://alice.nearchant.com/");
  });

  it("other messages go to the buyer-chat agent; groups are ignored; failures get a safe answer", async () => {
    const { api, sent } = fakeTelegram();
    await handleUpdate(api, shop, msg("how long does it take?"), async (t) => `answer to: ${t}`);
    expect(sent[0].text).toBe("answer to: how long does it take?");
    await handleUpdate(api, shop, msg("hi", "group"), async () => "x");
    expect(sent).toHaveLength(1);
    await handleUpdate(api, shop, msg("price?"), async () => { throw new Error("model down"); });
    expect(sent[1].text).toContain("can't answer right now");
  });

  it("verifies seller signatures by key, action, handle and time", () => {
    const k = KeyPair.fromRandom("ed25519");
    const now = Date.now();
    const message = `nearchant:telegram:alice:${now}`;
    const signature = Buffer.from(k.sign(new TextEncoder().encode(message)).signature).toString("base64");
    const base = { message, signature, publicKey: k.getPublicKey().toString(), handle: "alice", action: "telegram", now };
    expect(verifySellerSignature(base)).toBe(true);
    expect(verifySellerSignature({ ...base, handle: "bob" })).toBe(false);
    expect(verifySellerSignature({ ...base, action: "payout" })).toBe(false);
    expect(verifySellerSignature({ ...base, now: now + 10 * 60_000 })).toBe(false);
    expect(verifySellerSignature({ ...base, publicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString() })).toBe(false);
    // Body-bound signatures: the hash must match what the server computes from the request.
    const h = bodyHash("123:token");
    const m2 = `nearchant:telegram:alice:${now}:${h}`;
    const s2 = Buffer.from(k.sign(new TextEncoder().encode(m2)).signature).toString("base64");
    expect(verifySellerSignature({ ...base, message: m2, signature: s2, bodyHash: h })).toBe(true);
    expect(verifySellerSignature({ ...base, message: m2, signature: s2, bodyHash: bodyHash("other-token") })).toBe(false);
    expect(verifySellerSignature({ ...base, bodyHash: h })).toBe(false); // unsigned body
  });

  it("token and secret helpers", () => {
    expect(validBotToken("1234567890:" + "A".repeat(35))).toBe(true);
    expect(validBotToken("nope")).toBe(false);
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3cret", "other")).toBe(false);
    expect(secretMatches("s3cret", undefined)).toBe(false);
  });
});
