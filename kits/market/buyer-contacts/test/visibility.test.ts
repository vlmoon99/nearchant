import { describe, expect, it } from "vitest";
import { DAY_MS, contactVisible } from "../src/index.js";

const now = Date.parse("2026-11-08T12:00:00Z");
const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();

describe("contactVisible", () => {
  it("shows it while the order is open, however old", () => {
    for (const state of ["paid", "in_progress", "delivered", "disputed"]) expect(contactVisible({ state, updatedAt: ago(400) }, { now })).toBe(true);
  });
  it("keeps it 90 days after the order closes, then hides it", () => {
    expect(contactVisible({ state: "released", updatedAt: ago(89) }, { now })).toBe(true);
    expect(contactVisible({ state: "refunded", updatedAt: ago(89.99) }, { now })).toBe(true);
    expect(contactVisible({ state: "released", updatedAt: ago(90) }, { now })).toBe(false);
    expect(contactVisible({ state: "refunded", updatedAt: ago(365) }, { now })).toBe(false);
  });
  it("takes the window and the closed states as options", () => {
    expect(contactVisible({ state: "released", updatedAt: ago(10) }, { now, keepMs: 7 * DAY_MS })).toBe(false);
    expect(contactVisible({ state: "released", updatedAt: ago(10) }, { now, keepMs: 0 })).toBe(false);
    expect(contactVisible({ state: "cancelled", updatedAt: ago(100) }, { now, closedStates: ["cancelled"] })).toBe(false);
    expect(contactVisible({ state: "released", updatedAt: ago(100) }, { now, closedStates: ["cancelled"] })).toBe(true);
  });
  it("accepts a Date or ms, and hides a closed order with an unreadable date", () => {
    expect(contactVisible({ state: "released", updatedAt: new Date(now - DAY_MS) }, { now })).toBe(true);
    expect(contactVisible({ state: "released", updatedAt: now - DAY_MS }, { now })).toBe(true);
    expect(contactVisible({ state: "released", updatedAt: "not a date" }, { now })).toBe(false);
  });
  it("uses the real clock by default", () => expect(contactVisible({ state: "released", updatedAt: new Date() })).toBe(true));
});
