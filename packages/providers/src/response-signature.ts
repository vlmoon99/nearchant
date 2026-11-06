// NEAR AI response signatures (docs.near.ai/cloud/verification/cloud-api/response-signatures): after a chat
// completion, GET /v1/signature/{id} returns NEAR AI's signature of the exact bytes. We verify it ourselves:
//   provider_tee: text = "<model>:<sha256(request bytes)>:<sha256(response bytes)>", signed by the model TEE's key,
//                 which must be one of the keys bound into the attestation report we pinned before sending data;
//   gateway:      text = "<sha256(request)>:<sha256(response)>", signed by the attested gateway only (weaker: it proves
//                 the gateway passed these bytes on, not that the model's own TEE produced them).
// ed25519 throughout (Node verifies it natively).
import { createHash, createPublicKey, verify } from "node:crypto";
import type { ResponseSignature } from "@nearchant/contracts";

export interface RawSignature { text?: string; signature?: string; signing_address?: string; signing_algo?: string; signature_kind?: string }

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Valid(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    const pub = Buffer.from(publicKeyHex.replace(/^0x/, ""), "hex");
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (pub.length !== 32 || sig.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" }), sig);
  } catch { return false; }
}

export function checkResponseSignature(a: { model: string; request: string; response: string; sig: RawSignature | null; modelSigners: string[]; gatewaySigner?: string }): ResponseSignature {
  const s = a.sig;
  if (!s?.signature || !s.text || !s.signing_address) return { kind: "none", verified: false, error: "no signature" };
  const kind = s.signature_kind === "provider_tee" || s.signature_kind === "gateway" ? s.signature_kind : null;
  const base = { signingAlgo: s.signing_algo ?? "", signingAddress: s.signing_address, text: s.text, signature: s.signature };
  // An unknown kind is not guessed from the shape of the text (NEAR AI's rule).
  if (!kind) return { kind: "none", ...base, verified: false, error: `unknown signature_kind ${s.signature_kind ?? ""}` };
  const fail = (error: string): ResponseSignature => ({ kind, ...base, verified: false, error });
  if (s.signing_algo !== "ed25519") return fail(`unexpected algorithm ${s.signing_algo}`);
  const want = kind === "provider_tee" ? `${a.model}:${sha(a.request)}:${sha(a.response)}` : `${sha(a.request)}:${sha(a.response)}`;
  if (s.text !== want) return fail("signed text does not match our request/response hashes");
  const signer = s.signing_address.replace(/^0x/, "").toLowerCase();
  const allowed = kind === "provider_tee" ? a.modelSigners.map((x) => x.replace(/^0x/, "").toLowerCase()) : a.gatewaySigner ? [a.gatewaySigner.replace(/^0x/, "").toLowerCase()] : [];
  if (!allowed.includes(signer)) return fail("signer is not a key from the pinned attestation report");
  if (kind === "provider_tee" && allowed.filter((x) => x === signer).length !== 1) return fail("signer matches more than one report entry");
  if (!ed25519Valid(signer, s.text, s.signature)) return fail("bad signature");
  return { kind, ...base, verified: true };
}
