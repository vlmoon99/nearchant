// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWallet, existingTestWallet } from "../src/index.js";
import { fakeRpc } from "./fake-rpc.js";

beforeEach(() => localStorage.clear());

describe("createTestWallet", () => {
  it("keeps one key in localStorage; the account id is the hex public key", () => {
    expect(existingTestWallet()).toBeNull();
    const a = createTestWallet();
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publicKey).toMatch(/^ed25519:/);
    expect(localStorage.getItem("nearkit:testnet:buyer-key")).toBe(a.exportKey());
    expect(createTestWallet().accountId).toBe(a.accountId);
    expect(existingTestWallet()).toBe(a.accountId);
  });

  it("separates networks and custom keys", () => {
    const a = createTestWallet({ storageKey: "shop:a" }), b = createTestWallet({ storageKey: "shop:b" });
    expect(a.accountId).not.toBe(b.accountId);
    a.forget();
    expect(localStorage.getItem("shop:a")).toBeNull();
  });

  it("refuses mainnet", () => {
    expect(() => createTestWallet({ network: "mainnet" })).toThrow(/testnet/);
  });

  it("ready() calls the fund hook when the account doesn't exist, then waits for it", async () => {
    const accounts = new Set<string>();
    const rpc = fakeRpc({}, accounts);
    const funded: string[] = [];
    const w = createTestWallet({ fetch: rpc.fetch, retries: 0, fund: async (id) => { funded.push(id); accounts.add(id); } });
    await expect(w.ready()).resolves.toBe(w);
    expect(funded).toEqual([w.accountId]);
    await w.ready();
    expect(funded).toHaveLength(1); // exists now: no second faucet call
  });

  it("ready() without a fund hook says what to do", async () => {
    const rpc = fakeRpc({});
    await expect(createTestWallet({ fetch: rpc.fetch, retries: 0 }).ready()).rejects.toThrow(/fund hook/);
  });
});
