// Read-only checks against real NEAR testnet (no keys, no money): NEARKIT_LIVE=1 npx vitest run test/live.test.ts
import { describe, expect, it } from "vitest";
import { accountExists, tokenBalance, viewCall } from "../src/index.js";

describe.skipIf(!process.env.NEARKIT_LIVE)("testnet (live)", () => {
  it("reads Nearchant's escrow and token", async () => {
    const params = await viewCall<Record<string, unknown>>("orders.nearchant.testnet", "get_params", {}, { network: "testnet" });
    expect(params).toHaveProperty("release_after_ns");
    expect(await viewCall("nusd.nearchant.testnet", "storage_balance_of", { account_id: "orders.nearchant.testnet" })).not.toBeNull();
    expect(await tokenBalance({ token: "nusd.nearchant.testnet", accountId: "orders.nearchant.testnet" })).toBeTypeOf("bigint");
    expect(await viewCall("orders.nearchant.testnet", "get_order", { order_id: "o-does-not-exist" })).toBeNull();
    expect(await accountExists([...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join(""))).toBe(false);
    expect(await accountExists("nearchant.testnet")).toBe(true);
  }, 30_000);
});
