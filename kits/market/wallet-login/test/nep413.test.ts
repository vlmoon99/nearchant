import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { decodeSignature, nep413Payload, parsePublicKey, verifyNep413, verifyWalletSignature } from "../src/index.js";
import { fixedKey, walletSign } from "./helpers.js";

// A fixed vector: key, message, nonce 0..31. The payload bytes and signature were cross-checked against Nearchant's
// gateway verifier (apps/gateway/src/nep413.ts), which signs in real wallets in production.
const PK = "ed25519:DjCgEt3V5TB4uqFoYRgTBUuyC7nVNV1LxD5S4QTXDA9e";
const SIG = "SS37qQkY8cvICr5iI7oe8r2+ATPHhTUHHeZXfUSd6ujBb8Luw9xNFv7ZuQYrLbLOS/yOB+EBbb3PPSogJwI6Dg==";
const msg = { message: "Sign in to shop.example", nonce: new Uint8Array(32).map((_, i) => i), recipient: "shop.example", callbackUrl: null };

describe("NEP-413 payload", () => {
  it("is tag ‖ borsh(message, nonce, recipient, callbackUrl)", () => {
    expect(Buffer.from(nep413Payload(msg)).toString("hex")).toBe(
      "9d010080" + "17000000" + Buffer.from("Sign in to shop.example").toString("hex") + "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      + "0c000000" + Buffer.from("shop.example").toString("hex") + "00");
    expect(Buffer.from(nep413Payload({ ...msg, callbackUrl: "https://shop.example/cb" })).toString("hex").endsWith("01" + "17000000" + Buffer.from("https://shop.example/cb").toString("hex"))).toBe(true);
    expect(() => nep413Payload({ ...msg, nonce: new Uint8Array(31) })).toThrow();
  });

  it("matches the fixed vector", () => {
    expect(fixedKey().getPublicKey().toString()).toBe(PK);
    expect(walletSign(fixedKey(), msg)).toBe(SIG);
    expect(verifyNep413(msg, PK, SIG)).toBe(true);
  });

  it("fails when anything signed changes", () => {
    expect(verifyNep413({ ...msg, message: "Sign in to shop.examplf" }, PK, SIG)).toBe(false);
    expect(verifyNep413({ ...msg, recipient: "evil.example" }, PK, SIG)).toBe(false);
    expect(verifyNep413({ ...msg, nonce: new Uint8Array(32) }, PK, SIG)).toBe(false);
    expect(verifyNep413({ ...msg, callbackUrl: "https://x" }, PK, SIG)).toBe(false);
    expect(verifyNep413(msg, "ed25519:" + base58.encode(new Uint8Array(32).fill(7)), SIG)).toBe(false);
    expect(verifyNep413(msg, PK, "not a signature")).toBe(false);
  });

  it("accepts a signature made with or without callbackUrl", () => {
    const withCb = { ...msg, callbackUrl: "https://shop.example/cb" };
    expect(verifyWalletSignature(withCb, PK, SIG)).toBe(true); // wallet dropped it
    expect(verifyWalletSignature(withCb, PK, walletSign(fixedKey(), withCb))).toBe(true);
  });

  it("decodes keys and base64 / base64url / base58 signatures", () => {
    expect(parsePublicKey(PK)).toHaveLength(32);
    expect(() => parsePublicKey("secp256k1:abc")).toThrow();
    const raw = Buffer.from(SIG, "base64");
    expect(decodeSignature(SIG)).toEqual(new Uint8Array(raw));
    expect(decodeSignature(raw.toString("base64url"))).toEqual(new Uint8Array(raw));
    expect(decodeSignature(base58.encode(raw))).toEqual(new Uint8Array(raw));
  });
});
