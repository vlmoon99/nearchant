import { describe, expect, it } from "vitest";
import { createChallenge, memoryNonceStore, nonceIssuedAt, statusFor, verifySignedMessage, type Challenge, type VerifyOptions } from "../src/index.js";
import { fromBase64 as fromB64ForTest } from "../src/nep413.js";
import { fakeRpc, randomKey, walletSign } from "./helpers.js";

const HOST = "shop.example", ACCOUNT = "alice.testnet";

/** A wallet answering a challenge. */
function answer(ch: Challenge, key = randomKey(), o: { accountId?: string; callbackUrl?: string | null } = {}) {
  const signed = { message: ch.message, nonce: fromB64ForTest(ch.nonce), recipient: ch.recipient, callbackUrl: o.callbackUrl ?? null };
  return { key, input: { message: ch.message, nonce: ch.nonce, signature: walletSign(key, signed), publicKey: key.getPublicKey().toString(), accountId: o.accountId ?? ACCOUNT, callbackUrl: o.callbackUrl ?? null } };
}
function setup(perm: "FullAccess" | "FunctionCall" | null = "FullAccess", rpcOpts: Parameters<typeof fakeRpc>[1] = {}) {
  const ch = createChallenge({ recipient: HOST });
  const a = answer(ch);
  const rpc = fakeRpc(perm ? { [`${ACCOUNT} ${a.input.publicKey}`]: perm } : {}, rpcOpts);
  const opts: VerifyOptions = { recipient: HOST, fetch: rpc.fetch, nonces: memoryNonceStore(), retries: 2 };
  return { ch, ...a, rpc, opts };
}

describe("createChallenge", () => {
  it("puts the issue time in the first 8 nonce bytes and randomness after", () => {
    const a = createChallenge({ recipient: HOST, now: 1_700_000_000_000 }), b = createChallenge({ recipient: HOST, now: 1_700_000_000_000 });
    expect(nonceIssuedAt(fromB64ForTest(a.nonce))).toBe(1_700_000_000_000);
    expect(fromB64ForTest(a.nonce)).toHaveLength(32);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a).toMatchObject({ message: "Sign in to shop.example", recipient: HOST, expiresAt: 1_700_000_600_000 });
  });
});

describe("verifySignedMessage", () => {
  it("accepts a fresh signature by a full-access key of the account", async () => {
    const s = setup();
    const r = await verifySignedMessage(s.input, s.opts);
    expect(r).toMatchObject({ ok: true, accountId: ACCOUNT, publicKey: s.input.publicKey });
    expect(statusFor(r)).toBe(200);
    expect(s.rpc.calls()).toBe(1);
  });

  it("rejects a tampered message", async () => {
    const s = setup();
    const r = await verifySignedMessage({ ...s.input, message: "Sign in to evil.example" }, s.opts);
    expect(r).toMatchObject({ ok: false, code: "bad_signature" });
    expect(statusFor(r)).toBe(401);
    expect(s.rpc.calls()).toBe(0);
  });

  it("rejects a signature made for another site", async () => {
    const ch = createChallenge({ recipient: "evil.example" });
    const s = setup();
    const a = answer(ch);
    expect(await verifySignedMessage(a.input, s.opts)).toMatchObject({ ok: false, code: "bad_signature" });
  });

  it("rejects an expired challenge and one from the future", async () => {
    const ch = createChallenge({ recipient: HOST, now: Date.now() - 11 * 60_000 });
    const s = setup();
    expect(await verifySignedMessage(answer(ch).input, s.opts)).toMatchObject({ ok: false, code: "expired" });
    const later = createChallenge({ recipient: HOST, now: Date.now() + 5 * 60_000 });
    expect(await verifySignedMessage(answer(later).input, s.opts)).toMatchObject({ ok: false, code: "expired" });
    const ok = createChallenge({ recipient: HOST, now: Date.now() - 11 * 60_000 });
    const a = answer(ok);
    const rpc = fakeRpc({ [`${ACCOUNT} ${a.input.publicKey}`]: "FullAccess" });
    expect(await verifySignedMessage(a.input, { ...s.opts, fetch: rpc.fetch, maxAgeMs: 15 * 60_000 })).toMatchObject({ ok: true });
  });

  it("rejects a replayed signature", async () => {
    const s = setup();
    expect((await verifySignedMessage(s.input, s.opts)).ok).toBe(true);
    expect(await verifySignedMessage(s.input, s.opts)).toMatchObject({ ok: false, code: "nonce_reused" });
  });

  it("rejects a key that isn't on the account", async () => {
    const s = setup(null);
    expect(await verifySignedMessage(s.input, s.opts)).toMatchObject({ ok: false, code: "not_full_access", reason: expect.stringMatching(/not on this account/) });
  });

  it("rejects a function-call key (what dapps hold)", async () => {
    const s = setup("FunctionCall");
    expect(await verifySignedMessage(s.input, s.opts)).toMatchObject({ ok: false, code: "not_full_access", reason: expect.stringMatching(/only call contracts/) });
  });

  it("rejects the right key claimed for another account", async () => {
    const s = setup();
    expect(await verifySignedMessage({ ...s.input, accountId: "bob.testnet" }, s.opts)).toMatchObject({ ok: false, code: "not_full_access" });
  });

  it("retries the RPC on network errors and 5xx", async () => {
    const s = setup("FullAccess", { failFirst: 2 });
    expect(await verifySignedMessage(s.input, s.opts)).toMatchObject({ ok: true });
    expect(s.rpc.calls()).toBe(3);
    const t = setup("FullAccess", { failFirst: 1, status: 503 });
    expect(await verifySignedMessage(t.input, t.opts)).toMatchObject({ ok: true });
  });

  it("says rpc_unavailable (503) when NEAR can't be reached", async () => {
    const s = setup("FullAccess", { failFirst: 99 });
    const r = await verifySignedMessage(s.input, s.opts);
    expect(r).toMatchObject({ ok: false, code: "rpc_unavailable" });
    expect(statusFor(r)).toBe(503);
    expect(s.rpc.calls()).toBe(3);
  });

  it("times out a hanging RPC", async () => {
    const s = setup();
    let n = 0;
    const hang: VerifyOptions["fetch"] = (_u, init) => { n++; return new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))); };
    const r = await verifySignedMessage(s.input, { ...s.opts, fetch: hang, timeoutMs: 20, retries: 1 });
    expect(r).toMatchObject({ ok: false, code: "rpc_unavailable" });
    expect(n).toBe(2);
  });

  it("accepts a redirect wallet's signature that includes callbackUrl", async () => {
    const ch = createChallenge({ recipient: HOST });
    const a = answer(ch, randomKey(), { callbackUrl: "https://shop.example/cb" });
    const rpc = fakeRpc({ [`${ACCOUNT} ${a.input.publicKey}`]: "FullAccess" });
    expect(await verifySignedMessage(a.input, { recipient: HOST, fetch: rpc.fetch, nonces: null })).toMatchObject({ ok: true });
  });

  it("checks input shape and an expected message", async () => {
    const s = setup();
    expect(await verifySignedMessage({ ...s.input, accountId: "Not An Account!" }, s.opts)).toMatchObject({ code: "bad_input" });
    expect(await verifySignedMessage({ ...s.input, nonce: "AAAA" }, s.opts)).toMatchObject({ code: "bad_input" });
    expect(statusFor(await verifySignedMessage({ ...s.input, nonce: "AAAA" }, s.opts))).toBe(400);
    expect(await verifySignedMessage(s.input, { ...s.opts, expectedMessage: "Sign in to other" })).toMatchObject({ code: "bad_signature" });
  });

  it("can skip the chain check (requireFullAccess: false)", async () => {
    const s = setup(null);
    expect(await verifySignedMessage(s.input, { ...s.opts, requireFullAccess: false })).toMatchObject({ ok: true });
    expect(s.rpc.calls()).toBe(0);
  });
});
