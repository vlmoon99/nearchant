// NEP-413 "sign a message": how a NEAR wallet proves it controls an account without a transaction.
// The wallet signs sha256( u32 LE 2^31+413 ‖ borsh{ message: string, nonce: [u8; 32], recipient: string,
// callbackUrl: Option<string> } ) with the account's key. We rebuild the same bytes and check the ed25519 signature.
// Pure JS (noble), so it runs in Node, Deno, Bun, workers and browsers alike.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Message {
  message: string;
  /** 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

const enc = new TextEncoder();
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const str = (s: string) => { const b = enc.encode(s); return concat(u32(b.length), b); };
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The exact bytes a wallet hashes and signs. */
export function nep413Payload(p: Nep413Message): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const cb = p.callbackUrl == null ? new Uint8Array([0]) : concat(new Uint8Array([1]), str(p.callbackUrl));
  return concat(u32(NEP413_TAG), str(p.message), p.nonce, str(p.recipient), cb);
}

/** "ed25519:<base58>" → the 32 raw bytes. Throws for other key types. */
export function parsePublicKey(publicKey: string): Uint8Array {
  const [type, data] = publicKey.includes(":") ? publicKey.split(":", 2) : ["ed25519", publicKey];
  if (type !== "ed25519" || !data) throw new Error("only ed25519 keys are supported");
  const raw = base58.decode(data);
  if (raw.length !== 32) throw new Error("bad ed25519 public key");
  return raw;
}

/** Wallets send the signature as base64 (most) or base58 (a few older ones); accept both. */
export function decodeSignature(signature: string): Uint8Array {
  const s = signature.replace(/^ed25519:/, "");
  try { const b = base64.decode(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")); if (b.length === 64) return b; } catch { /* try base58 */ }
  const b = base58.decode(s);
  if (b.length !== 64) throw new Error("bad signature");
  return b;
}

/** True when `signature` by `publicKey` covers this NEP-413 message. Never throws. */
export function verifyNep413(p: Nep413Message, publicKey: string, signature: string): boolean {
  try {
    return ed25519.verify(decodeSignature(signature), sha256(nep413Payload(p)), parsePublicKey(publicKey));
  } catch {
    return false;
  }
}

/** Some wallets (Meteor through Wallet Selector 10.1.4) drop callbackUrl before signing; redirect wallets keep it.
 *  callbackUrl only says where a redirect wallet goes next — message, nonce and recipient bind the sign-in — so a
 *  signature with or without it is accepted. */
export function verifyWalletSignature(p: Nep413Message, publicKey: string, signature: string): boolean {
  return verifyNep413(p, publicKey, signature) || (p.callbackUrl != null && verifyNep413({ ...p, callbackUrl: null }, publicKey, signature));
}

export const toBase64 = (b: Uint8Array) => base64.encode(b);
export const fromBase64 = (s: string) => base64.decode(s);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
