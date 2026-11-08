// Against real NEAR testnet, read-only: NEARKIT_LIVE=1 npx vitest run test/live.test.ts
import { describe, expect, it } from "vitest";
import { accessKeyPermission } from "../src/index.js";

describe.skipIf(!process.env.NEARKIT_LIVE)("testnet (live)", () => {
  it("tells a full-access key from an unknown one", async () => {
    // A public full-access key of a testnet account, read from the chain itself.
    const r = await fetch("https://test.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "optimistic", account_id: "nearchant.testnet" } }) });
    const keys = ((await r.json()) as { result: { keys: { public_key: string; access_key: { permission: unknown } }[] } }).result.keys;
    const full = keys.find((k) => k.access_key.permission === "FullAccess")!;
    expect(await accessKeyPermission("nearchant.testnet", full.public_key, { network: "testnet" })).toBe("FullAccess");
    expect(await accessKeyPermission("nearchant.testnet", "ed25519:DjCgEt3V5TB4uqFoYRgTBUuyC7nVNV1LxD5S4QTXDA9e", { network: "testnet" })).toBeNull();
    expect(await accessKeyPermission(`nope-${Date.now()}.testnet`, full.public_key, { network: "testnet" })).toBeNull();
  }, 30_000);
});
