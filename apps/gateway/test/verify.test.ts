import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountUi } from "../src/ui/routes.js";
import { signSession } from "../src/seller-app.js";

const h = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function setup(caption: string) {
  const mediaDir = mkdtempSync(join(tmpdir(), "nc-verify-"));
  mkdirSync(join(mediaDir, "nova", "public"), { recursive: true }); mkdirSync(join(mediaDir, "attestations"), { recursive: true });
  const pic = Buffer.from("the published picture");
  writeFileSync(join(mediaDir, "nova", "public", "p1.png"), pic);
  const rep = "ab".repeat(32);
  writeFileSync(join(mediaDir, "attestations", `${rep}.check.json`), JSON.stringify({ ok: true }));
  const entry = { proof_id: "21", task_id: "post:p1", author_id: "nova.nearchant.testnet", output_hash: h(`Soft linen.\n${h(pic)}`), producer: "nearchant:content-store", attestation_ref: `nearai:Qwen/Qwen3.6-35B-A3B-FP8:${rep}`, review: { passed: true }, created_at: "1793552641150717215" };
  const post = { id: "p1", handle: "nova", caption, idea: { publicImage: "nova/public/p1.png" }, proof: { proofId: "21" } };
  const content = { showcase: async () => ({ posts: [{ proofId: "21", storeName: "Nova Wear NYC", caption }] }), getPost: async () => post, getBusiness: async () => ({ name: "Nova Wear NYC" }) };
  const app = new Hono();
  mountUi(app, { cfg: { base: "/", rpcUrl: "", network: "testnet", token: "nUSD", decimals: 6, storeBase: "" }, test: true, css: "", js: undefined, sessionKey: Buffer.alloc(32),
    content: content as never, accountOf: (x) => `${x}.nearchant.testnet`, explorer: (a) => `https://testnet.nearblocks.io/address/${a}`, mediaDir,
    proof: async (id) => (id === "21" ? entry : id === "22" ? { ...entry, proof_id: "22", author_id: "attacker.testnet" } : null), proofsContract: "proofs.nearchant.testnet" } as never);
  return app;
}

describe("verify a post", () => {
  it("recomputes the fingerprint from the published caption and picture: unchanged", async () => {
    const html = await (await setup("Soft linen.").request("http://x/verify/21")).text();
    expect(html).toContain("The post is unchanged");
    expect(html).toContain("Published by nova.nearchant.testnet");
    expect(html).toContain("Caption check passed");
    expect(html).toContain("Written by Qwen/Qwen3.6-35B-A3B-FP8 in a NEAR AI TEE");
  });
  it("a caption edited after the proof shows as changed; a missing proof says so", async () => {
    const app = setup("Soft linen. 50% off!");
    expect(await (await app.request("http://x/verify/21")).text()).toContain("The post was changed after the proof");
    expect(await (await app.request("http://x/verify?id=99")).text()).toContain("No proof #99 on NEAR");
    expect(await (await app.request("http://x/verify")).text()).toContain("Latest proofs");
  });

  it("a proof someone else recorded for a store's post is shown as not from the store", async () => {
    const html = await (await setup("Soft linen.").request("http://x/verify/22")).text();
    expect(html).toContain("is not from a Nearchant store");
    expect(html).not.toContain("The post is unchanged");
    expect(html).not.toContain("Written by");
  });
});

describe("selling ↔ shopping", () => {
  it("/sell opens the signed-in store, or creating one", async () => {
    const app = setup("x");
    const r1 = await app.request("http://x/sell");
    expect([r1.status, r1.headers.get("location")]).toEqual([302, "/start"]);
    const r2 = await app.request("http://x/sell", { headers: { cookie: `nc_session=${signSession(Buffer.alloc(32), "nova", Date.now() + 60_000)}` } });
    expect(r2.headers.get("location")).toBe("/app");
  });
});

