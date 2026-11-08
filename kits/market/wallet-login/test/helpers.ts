// Test keys come from near-api-js (the library wallets and NEAR tools use), so the vectors are real NEAR keys.
import { sha256 } from "@noble/hashes/sha2.js";
import { KeyPair, type KeyPairString } from "near-api-js-v7";
import { nep413Payload, type Nep413Message } from "../src/index.js";
import type { FetchLike } from "../src/index.js";

// A throwaway key made for this test vector only; it controls no account.
export const fixedKey = () => KeyPair.fromString("ed25519:3qumDXKpiG2PBfPJLdDoLwZyy2xxVsnJPmNwtj9xeM3pWAYHrV99jaEiW9i9B3tGjHFSxFw8Y7oCmZNFP6AFaSzc" as KeyPairString);
export const randomKey = () => KeyPair.fromRandom("ed25519");

/** What a wallet does for signMessage: ed25519 over sha256(NEP-413 payload), base64. */
export function walletSign(key: KeyPair, m: Nep413Message): string {
  return Buffer.from(key.sign(sha256(nep413Payload(m))).signature).toString("base64");
}

/** view_access_key answers: keys[`${account} ${publicKey}`] = "FullAccess" | "FunctionCall"; anything else unknown. */
export function fakeRpc(keys: Record<string, "FullAccess" | "FunctionCall">, o: { failFirst?: number; status?: number } = {}) {
  let calls = 0;
  const fetch: FetchLike = async (_u, init) => {
    calls++;
    if (calls <= (o.failFirst ?? 0)) {
      if (o.status) return { ok: false, status: o.status, json: async () => ({}) };
      throw new Error("ECONNRESET");
    }
    const p = (JSON.parse(init.body) as { params: { account_id: string; public_key: string; request_type: string; finality: string } }).params;
    if (p.request_type !== "view_access_key" || p.finality !== "optimistic") throw new Error("unexpected request");
    const perm = keys[`${p.account_id} ${p.public_key}`];
    const json = perm === "FullAccess" ? { result: { nonce: 1, permission: "FullAccess" } }
      : perm === "FunctionCall" ? { result: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "app.near", method_names: [] } } } }
      : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } };
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetch, calls: () => calls };
}
