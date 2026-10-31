import { describe, expect, it } from "vitest";
import { HandleCache, TestnetDirectRail, handleFromHost, loadAccounts, validHandle, type HandleRecord, type Viewer } from "../src/index.js";

const rec = (handle: string): HandleRecord => ({
  handle, owner_id: "o.testnet", account_id: `${handle}.nearchant.testnet`, payout_account_id: `${handle}.nearchant.testnet`,
  payout_token_id: null, card: { name: handle, bio: "", avatar_hash: null, links: [] }, gateway_url: null,
  embed_origins: [], status: "Active", created_at: "0", card_published_at: null,
});

describe("handles", () => {
  it("validates names like the contract", () => {
    for (const ok of ["al", "alice", "bob_1", "a-b-c", "x".repeat(32)]) expect(validHandle(ok)).toBe(true);
    for (const bad of ["a", "Alice", "al.ice", "-al", "al-", "a--b", "a_-b", "x".repeat(33), ""]) expect(validHandle(bad)).toBe(false);
  });

  it("takes exactly one label under the base domain", () => {
    const bases = ["nearchant.com", "localhost"];
    expect(handleFromHost("alice.nearchant.com", bases)).toBe("alice");
    expect(handleFromHost("Alice.Nearchant.com:443", bases)).toBe("alice");
    expect(handleFromHost("alice.localhost:8787", bases)).toBe("alice");
    expect(handleFromHost("shop.alice.nearchant.com", bases)).toBeNull();
    expect(handleFromHost("nearchant.com", bases)).toBeNull();
    expect(handleFromHost("alice.evil.com", bases)).toBeNull();
  });

  it("caches hits and misses, dedupes concurrent loads, serves stale only while RPC is down", async () => {
    let t = 0;
    let calls = 0;
    let down = false;
    const view: Viewer = async <T,>(_c: string, _m: string, args?: Record<string, unknown>) => {
      calls++;
      if (down) throw new Error("rpc down");
      return (args?.handle === "alice" ? rec("alice") : null) as T;
    };
    const cache = new HandleCache(view, "nearchant.testnet", { ttlMs: 1000, missTtlMs: 100, maxStaleMs: 5000, now: () => t });
    const [a, b] = await Promise.all([cache.get("alice"), cache.get("alice")]);
    expect(a?.account_id).toBe("alice.nearchant.testnet");
    expect(b).toBe(a);
    expect(calls).toBe(1);
    expect(await cache.get("nobody")).toBeNull();
    expect(await cache.get("nobody")).toBeNull();
    expect(calls).toBe(2);
    expect(await cache.get("Bad.Name")).toBeNull();
    expect(calls).toBe(2);

    t = 2000; down = true;
    expect((await cache.get("alice"))?.handle).toBe("alice"); // stale but within maxStale
    t = 10_000;
    await expect(cache.get("alice")).rejects.toThrow("rpc down");
  });
});

describe("rails", () => {
  it("testnet-direct builds the ft_transfer_call the buyer signs", () => {
    const accounts = loadAccounts(new URL("../../../config/defaults/accounts.yaml", import.meta.url).pathname, "testnet");
    const rail = new TestnetDirectRail(accounts, (async () => null) as Viewer);
    const i = rail.instruction({ orderId: "o-1", sellerHandle: "alice", amount: "5000000" });
    expect(i.receiverId).toBe("nusd.nearchant.testnet");
    expect(i.args.receiver_id).toBe("orders.nearchant.testnet");
    expect(JSON.parse(i.args.msg as string)).toEqual({ order_id: "o-1", seller_handle: "alice" });
    expect(i.depositYocto).toBe("1");
    expect(() => rail.instruction({ orderId: "o", sellerHandle: "a", amount: "1.5" })).toThrow();
  });
});
