import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkResponseSignature } from "../src/response-signature.js";

// A stand-in TEE key (ed25519) signing the way NEAR AI does.
const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  return { pub, signText: (t: string) => sign(null, Buffer.from(t), privateKey).toString("hex") };
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const model = "Qwen/Qwen3.6-35B-A3B-FP8", request = '{"model":"Qwen/Qwen3.6-35B-A3B-FP8","messages":[]}', response = '{"id":"chatcmpl-1","choices":[]}';

describe("NEAR AI response signatures", () => {
  it("provider_tee: the model TEE's attested key signed model:sha256(request):sha256(response)", () => {
    const k = key(), text = `${model}:${sha(request)}:${sha(response)}`;
    const r = checkResponseSignature({ model, request, response, modelSigners: [k.pub], sig: { text, signature: k.signText(text), signing_address: k.pub, signing_algo: "ed25519", signature_kind: "provider_tee" } });
    expect(r).toMatchObject({ kind: "provider_tee", verified: true, signingAddress: k.pub });
  });
  it("gateway: valid only for the attested gateway key, and labelled as the weaker kind", () => {
    const g = key(), text = `${sha(request)}:${sha(response)}`;
    const sig = { text, signature: g.signText(text), signing_address: g.pub, signing_algo: "ed25519", signature_kind: "gateway" };
    expect(checkResponseSignature({ model, request, response, modelSigners: [], gatewaySigner: g.pub, sig })).toMatchObject({ kind: "gateway", verified: true });
    expect(checkResponseSignature({ model, request, response, modelSigners: [g.pub], sig }).verified).toBe(false);
  });
  it("refuses: other bytes, a key outside the report, a forged signature, an unknown kind, no signature", () => {
    const k = key(), other = key(), text = `${model}:${sha(request)}:${sha(response)}`;
    const good = { text, signature: k.signText(text), signing_address: k.pub, signing_algo: "ed25519", signature_kind: "provider_tee" };
    expect(checkResponseSignature({ model, request, response: `${response} `, modelSigners: [k.pub], sig: good }).error).toMatch(/does not match/);
    expect(checkResponseSignature({ model, request, response, modelSigners: [other.pub], sig: good }).error).toMatch(/not a key/);
    expect(checkResponseSignature({ model, request, response, modelSigners: [k.pub], sig: { ...good, signature: other.signText(text) } }).error).toBe("bad signature");
    expect(checkResponseSignature({ model, request, response, modelSigners: [k.pub], sig: { ...good, signature_kind: "tee" } })).toMatchObject({ kind: "none", verified: false });
    expect(checkResponseSignature({ model, request, response, modelSigners: [k.pub], sig: null })).toMatchObject({ kind: "none", verified: false });
  });
});
