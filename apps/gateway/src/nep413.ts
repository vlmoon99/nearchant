// NEP-413 "sign a message" from a NEAR wallet (MyNearWallet, Meteor, …): how the owner's own wallet proves it controls
// an account without sending a transaction. The wallet signs sha256(u32 LE 2^31+413 ‖ borsh{message, nonce[32],
// recipient, callbackUrl?}); the gateway rebuilds the same bytes and checks the ed25519 signature. Whether the key is
// a full-access key of that account is checked on chain by the caller (isOwnerKey).
import { createHash } from "node:crypto";
import { PublicKey } from "near-api-js";

export const NEP413_TAG = 2 ** 31 + 413;
export interface Nep413 { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }

const str = (s: string) => { const b = Buffer.from(s, "utf8"); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };

/** The exact bytes a wallet hashes and signs. */
export function nep413Payload(p: Nep413): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4); tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(p.callbackUrl)]);
  return Buffer.concat([tag, str(p.message), Buffer.from(p.nonce), str(p.recipient), cb]);
}

/** True when `signature` (base64) by `publicKey` ("ed25519:…") covers this NEP-413 message. */
export function verifyNep413(p: Nep413, publicKey: string, signature: string): boolean {
  try {
    const hash = createHash("sha256").update(nep413Payload(p)).digest();
    return PublicKey.fromString(publicKey).verify(hash, Buffer.from(signature, "base64"));
  } catch { return false; }
}

/** What the sign-in routes check. Wallets that answer in the page (Meteor through Wallet Selector 10.1.4, which drops
 *  callbackUrl before asking the wallet) sign with no callbackUrl, redirect wallets sign with it, so either form is
 *  accepted. callbackUrl only says where a redirect wallet goes next; message, nonce and recipient bind the sign-in. */
export function verifyWalletSignature(p: Nep413, publicKey: string, signature: string): boolean {
  return verifyNep413(p, publicKey, signature) || (p.callbackUrl != null && verifyNep413({ ...p, callbackUrl: null }, publicKey, signature));
}
