import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits, rpc, RpcError, tokenBalance, viewCall, type FetchLike } from "../src/index.js";
import { fakeRpc } from "./fake-rpc.js";

describe("rpc", () => {
  it("retries a 503 and then succeeds", async () => {
    let n = 0;
    const f: FetchLike = async () => (++n < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ result: { ok: 1 } }) });
    await expect(rpc("status", [], { fetch: f, retries: 2 })).resolves.toEqual({ ok: 1 });
    expect(n).toBe(3);
  });

  it("times out a hanging request and gives up after the retries", async () => {
    let n = 0;
    const f: FetchLike = (_u, init) => { n++; return new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))); };
    await expect(rpc("status", [], { fetch: f, timeoutMs: 20, retries: 1 })).rejects.toBeInstanceOf(RpcError);
    expect(n).toBe(2);
  });

  it("does not retry a contract error", async () => {
    let n = 0;
    const f: FetchLike = async () => { n++; return { ok: true, status: 200, json: async () => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }) }; };
    await expect(rpc("query", {}, { fetch: f, retries: 3 })).rejects.toThrow(/UNKNOWN_ACCOUNT/);
    expect(n).toBe(1);
  });

  it("views with finality optimistic by default", async () => {
    const r = fakeRpc({ "c.near.get": (a) => ({ echo: a }) });
    await expect(viewCall("c.near", "get", { x: 1 }, { fetch: r.fetch })).resolves.toEqual({ echo: { x: 1 } });
    expect(r.calls[0]!.finality).toBe("optimistic");
  });
});

describe("tokenBalance", () => {
  it("reads ft_balance_of as a bigint", async () => {
    const r = fakeRpc({ "t.near.ft_balance_of": (a) => (a.account_id === "me" ? "123456789" : "0") });
    await expect(tokenBalance({ token: "t.near", accountId: "me", fetch: r.fetch })).resolves.toBe(123456789n);
  });
  it("is null when it can't be read", async () => {
    const f: FetchLike = async () => { throw new Error("offline"); };
    await expect(tokenBalance({ token: "t.near", accountId: "me", fetch: f, retries: 0 })).resolves.toBeNull();
  });
});

describe("units", () => {
  it("formats base units without floats", () => {
    expect(formatUnits("1234500000", 6)).toBe("1,234.5");
    expect(formatUnits(1n, 6)).toBe("0");
    expect(formatUnits("1999999", 6)).toBe("1.99");
    expect(formatUnits("340282366920938463463374607431768211455", 24, 4)).toBe("340,282,366,920,938.4634");
    expect(formatUnits("5", 0)).toBe("5");
  });
  it("parses amounts", () => {
    expect(parseUnits("1.5", 6)).toBe("1500000");
    expect(parseUnits("1,000", 2)).toBe("100000");
    expect(() => parseUnits("1.1234567", 6)).toThrow();
    expect(() => parseUnits("abc", 6)).toThrow();
  });
});
