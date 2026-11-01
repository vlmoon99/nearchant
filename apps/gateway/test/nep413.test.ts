import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { nep413Payload, verifyNep413 } from "../src/nep413.js";
import { walletSign } from "./wallet-helper.js";

describe("NEP-413", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  const p = { message: "nearchant:wallet:signin:1790000000000", nonce: randomBytes(32), recipient: "nearchant.com", callbackUrl: "https://nearchant.com/app/wallet" };
  it("payload starts with the 2^31+413 tag, little-endian", () => {
    expect(nep413Payload(p).subarray(0, 4)).toEqual(Buffer.from([0x9d, 0x01, 0x00, 0x80]));
  });
  it("accepts the wallet's signature and rejects any change", () => {
    const sig = walletSign(kp, p);
    expect(verifyNep413(p, pk, sig)).toBe(true);
    expect(verifyNep413({ ...p, recipient: "evil.com" }, pk, sig)).toBe(false);
    expect(verifyNep413({ ...p, callbackUrl: null }, pk, sig)).toBe(false);
    expect(verifyNep413(p, KeyPair.fromRandom("ed25519").getPublicKey().toString(), sig)).toBe(false);
    expect(verifyNep413(p, "garbage", sig)).toBe(false);
  });
});
