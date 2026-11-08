import { describe, expect, it } from "vitest";
import { explainNearError } from "../src/index.js";

describe("explainNearError", () => {
  it.each([
    ["Sender relayer.testnet does not have enough balance: NotEnoughBalance", /needs a top-up/],
    ["{\"LackBalanceForState\":{\"amount\":\"1\"}}", /needs a top-up/],
    ["request to https://rpc.testnet.near.org failed, reason: connect ETIMEDOUT", /slow to answer/],
    ["TypeError: fetch failed", /slow to answer/],
    ["Server error 503", /slow to answer/],
    ["timed out after 120000 ms", /slow to answer/],
    ["Smart contract panicked: Only the seller can mark delivered", /key on NEAR didn't sign/],
    ["InvalidAccessKeyError: method not allowed by this access key", /key on NEAR didn't sign/],
    ["InvalidTxError: InvalidNonce { tx_nonce: 5, ak_nonce: 6 }", /crossed/],
    ["Exceeded the prepaid gas.", /ran out of gas/],
    ["Account bob.testnet does not exist while viewing", /doesn't exist/],
  ])("%s", (raw, want) => expect(explainNearError(raw)).toMatch(want));

  it("names who pays", () => expect(explainNearError("NotEnoughBalance", { payer: "Nearchant's" })).toBe("Nearchant's NEAR account needs a top-up. It retries by itself."));
  it("shortens unknown errors", () => {
    expect(explainNearError("x".repeat(500))).toHaveLength(140);
    expect(explainNearError("weird", { max: 3 })).toBe("wei");
    expect(explainNearError("")).toBe("");
  });
});
