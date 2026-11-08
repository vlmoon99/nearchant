// Server side of "Sign in with NEAR": hand out a challenge, then check what the wallet signed.
//
// The challenge is stateless: its 32-byte nonce starts with the issue time (8 bytes, ms, big-endian) followed by 24
// random bytes. The wallet signs the nonce, so the time can't be changed, and the server needs no table of open
// challenges. Replay inside the time window is blocked by a NonceStore (in-memory by default; use Redis/Postgres
// when you run more than one server).
import { fromBase64, toBase64, toHex, verifyWalletSignature } from "./nep413.js";
import { accessKeyPermission, RpcUnavailable, type RpcOptions } from "./rpc.js";

export interface Challenge {
  /** Text the wallet shows the person. */
  message: string;
  /** 32 bytes, base64. */
  nonce: string;
  /** Who the signature is for: your host, e.g. "shop.example". The wallet signs it, so a signature made for
   *  another site can't be replayed at yours. */
  recipient: string;
  /** ms since epoch; for the UI. The server checks age from the nonce itself. */
  expiresAt: number;
}

export function createChallenge(o: { recipient: string; message?: string; ttlMs?: number; now?: number }): Challenge {
  const now = o.now ?? Date.now();
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(now));
  nonce.set(globalThis.crypto.getRandomValues(new Uint8Array(24)), 8);
  return { message: o.message ?? `Sign in to ${o.recipient}`, nonce: toBase64(nonce), recipient: o.recipient, expiresAt: now + (o.ttlMs ?? 10 * 60_000) };
}

/** Issue time inside a createChallenge nonce. */
export const nonceIssuedAt = (nonce: Uint8Array) => Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0));

export interface NonceStore {
  /** Marks the nonce used. False when it was used before. `expiresAt`: when it may be forgotten. */
  use(nonceHex: string, expiresAt: number): Promise<boolean>;
}

/** One process only. With several servers, implement NonceStore on shared storage (INSERT … ON CONFLICT DO NOTHING). */
export function memoryNonceStore(now: () => number = Date.now): NonceStore {
  const used = new Map<string, number>();
  return {
    async use(n, expiresAt) {
      const t = now();
      if (used.size > 10_000) for (const [k, exp] of used) if (exp < t) used.delete(k);
      if (used.has(n)) return false;
      used.set(n, expiresAt);
      return true;
    },
  };
}

export interface VerifyInput {
  /** What the browser sent back (from signIn). */
  message: string;
  nonce: string | Uint8Array;
  signature: string;
  publicKey: string;
  accountId: string;
  callbackUrl?: string | null;
}

export interface VerifyOptions extends RpcOptions {
  /** YOUR recipient (from config, not from the request). A signature for anything else fails. */
  recipient: string;
  /** Oldest accepted challenge. Default 10 minutes. */
  maxAgeMs?: number;
  /** When set, the message must be exactly this (e.g. the challenge text you issue). */
  expectedMessage?: string;
  /** Blocks replays. Default: an in-memory store shared by all calls in this process. Pass null to skip. */
  nonces?: NonceStore | null;
  /** Default true: the key must be a FULL-ACCESS key of the account. A function-call key (what dapps get) can be
   *  held by any site the person ever connected to, so it doesn't prove ownership. */
  requireFullAccess?: boolean;
  now?: number;
}

export type VerifyCode = "bad_input" | "bad_signature" | "expired" | "nonce_reused" | "not_full_access" | "rpc_unavailable";
export type VerifyResult =
  | { ok: true; accountId: string; publicKey: string; issuedAt: number }
  | { ok: false; code: VerifyCode; reason: string };

const fail = (code: VerifyCode, reason: string): VerifyResult => ({ ok: false, code, reason });
/** HTTP status that fits each failure: 400 bad input, 503 when NEAR can't be asked, 401 otherwise. */
export const statusFor = (r: VerifyResult) => (r.ok ? 200 : r.code === "bad_input" ? 400 : r.code === "rpc_unavailable" ? 503 : 401);

const sharedNonces = memoryNonceStore();

/**
 * Checks a NEP-413 sign-in: input shape → age (from the nonce) → ed25519 signature over message+nonce+recipient →
 * nonce not used before → the key is a full-access key of `accountId` on chain (RPC view_access_key).
 */
export async function verifySignedMessage(input: VerifyInput, o: VerifyOptions): Promise<VerifyResult> {
  const now = o.now ?? Date.now();
  const accountId = String(input.accountId ?? "").toLowerCase();
  if (!/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(accountId)) return fail("bad_input", "not a NEAR account id");
  if (typeof input.message !== "string" || input.message.length > 2048) return fail("bad_input", "bad message");
  if (typeof input.signature !== "string" || typeof input.publicKey !== "string") return fail("bad_input", "signature and publicKey are required");
  let nonce: Uint8Array;
  try { nonce = typeof input.nonce === "string" ? fromBase64(input.nonce) : input.nonce; } catch { return fail("bad_input", "nonce is not base64"); }
  if (nonce.length !== 32) return fail("bad_input", "nonce must be 32 bytes");
  if (o.expectedMessage !== undefined && input.message !== o.expectedMessage) return fail("bad_signature", "unexpected message");

  const issuedAt = nonceIssuedAt(nonce), maxAge = o.maxAgeMs ?? 10 * 60_000;
  if (now - issuedAt > maxAge) return fail("expired", "the sign-in request expired; try again");
  if (issuedAt - now > 60_000) return fail("expired", "the sign-in request is from the future (clock skew?)");

  const signed = { message: input.message, nonce, recipient: o.recipient, callbackUrl: input.callbackUrl ?? null };
  if (!verifyWalletSignature(signed, input.publicKey, input.signature)) return fail("bad_signature", "the signature doesn't match (wrong site, message or key)");

  // Claim the nonce before the chain lookup, so two parallel requests can't both pass.
  const store = o.nonces === undefined ? sharedNonces : o.nonces;
  if (store && !(await store.use(toHex(nonce), issuedAt + maxAge + 60_000))) return fail("nonce_reused", "this signature was already used");

  if (o.requireFullAccess !== false) {
    let perm: Awaited<ReturnType<typeof accessKeyPermission>>;
    try { perm = await accessKeyPermission(accountId, input.publicKey, o); } catch (e) {
      return fail("rpc_unavailable", e instanceof RpcUnavailable ? e.message : String(e));
    }
    if (perm !== "FullAccess") return fail("not_full_access", perm ? "that key can only call contracts; sign with the account's full-access key" : "that key is not on this account");
  }
  return { ok: true, accountId, publicKey: input.publicKey, issuedAt };
}
