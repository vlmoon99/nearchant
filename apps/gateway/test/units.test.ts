import { describe, expect, it } from "vitest";
import { toUnits } from "../web/units.js";

describe("toUnits", () => {
  it("converts decimal amounts exactly", () => {
    expect(toUnits("12.5", 6)).toBe(12_500_000n);
    expect(toUnits("0.000001", 6)).toBe(1n);
    expect(toUnits("3", 6)).toBe(3_000_000n);
    expect(toUnits(" 1.10 ", 6)).toBe(1_100_000n);
  });
  it("refuses too many decimals and non-numbers", () => {
    expect(() => toUnits("0.0000001", 6)).toThrow();
    expect(() => toUnits("1e3", 6)).toThrow();
    expect(() => toUnits("-1", 6)).toThrow();
  });
});
