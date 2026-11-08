import { describe, expect, it } from "vitest";
import { findOpportunities, marketQueries, type Ask, type Message, type Search, type StyleProfile } from "../src/index.js";

const fakeAsk = (answers: unknown[], seen: Message[][] = []): Ask => async (m) => { seen.push(m); const a = answers.shift(); return typeof a === "string" ? a : JSON.stringify(a); };
const usr = (m: Message[]) => String(m[1]!.content);

const PROFILE: StyleProfile = { business_name: "Nova Wear", summary: "Relaxed clothes", products: [{ name: "Denim jacket", category: "denim" }, { name: "Linen shirt", category: "linen" }] };
const NOW = new Date("2026-11-08T00:00:00Z");
const LINEN = { title: "Linen is back", url: "https://example.com/linen", snippet: "searches up" };
const search: Search = async () => [LINEN];

const ANSWER = { opportunities: [
  { kind: "trend", title: "Linen is trending", why: "Searches are up", action: "Post linen Friday", estimate_usd_month: 180, confidence: "medium", source: "https://example.com/linen" },
  { kind: "trend", title: "Second trend", why: "dup kind", estimate_usd_month: 50, source: "https://example.com/linen" },
  { kind: "price", title: "Denim under market", why: "below similar", estimate_usd_month: 90, confidence: "high" },
  { kind: "upsell", title: "Denim + tee", why: "buyers add a tee", estimate_usd_month: 99999, confidence: "certain" },
  { kind: "channel", title: "Telegram", why: "buyers there", estimate_usd_month: "40" },
] };

describe("marketQueries", () => {
  it("builds trend and price queries for the top products", () => {
    expect(marketQueries(PROFILE, { now: NOW, place: "Kyiv" })).toEqual(["denim trend 2026 Kyiv", "linen trend 2026 Kyiv", "denim price Kyiv"]);
    expect(marketQueries({ business_name: "x", products: [] })).toEqual([]);
    expect(marketQueries(PROFILE, { now: NOW, max: 1 })).toEqual(["denim trend 2026"]);
  });
});

describe("findOpportunities", () => {
  it("keeps one per kind, clamps estimates, normalises confidence and drops price ideas without prices", async () => {
    const r = await findOpportunities(fakeAsk([ANSWER]), { profile: PROFILE, search, now: NOW });
    expect(r.searched).toBe(3);
    expect(r.opportunities.map((o) => o.kind)).toEqual(["trend", "upsell", "channel"]);
    const up = r.opportunities.find((o) => o.kind === "upsell")!;
    expect(up).toMatchObject({ estimate_usd_month: 1000, confidence: "low", source: "profile" });
    expect(r.opportunities.find((o) => o.kind === "channel")!.estimate_usd_month).toBe(40);
    expect(r.dropped.map((d) => d.reason)).toEqual(["one idea per kind", "price idea without the store's prices"]);
  });

  it("drops a trend whose source the search never returned", async () => {
    const fake = { opportunities: [{ kind: "trend", title: "Invented trend", why: "w", estimate_usd_month: 100, source: "https://nowhere.example" }] };
    const r = await findOpportunities(fakeAsk([fake]), { profile: PROFILE, search });
    expect(r.opportunities).toEqual([]);
    expect(r.dropped[0]!.reason).toBe("trend without a real source");
  });

  it("drops every trend when there is no search, and tells the model so", async () => {
    const seen: Message[][] = [];
    const r = await findOpportunities(fakeAsk([ANSWER], seen), { profile: PROFILE });
    expect(r.searched).toBe(0);
    expect(r.opportunities.map((o) => o.kind)).toEqual(["upsell", "channel"]);
    expect(usr(seen[0]!)).toContain("do not give a trend");
  });

  it("treats a failing or slow search as no results", async () => {
    const failing: Search = async () => { throw new Error("search down"); };
    expect((await findOpportunities(fakeAsk([ANSWER]), { profile: PROFILE, search: failing })).opportunities.map((o) => o.kind)).toEqual(["upsell", "channel"]);
    const slow: Search = () => new Promise(() => {});
    const r = await findOpportunities(fakeAsk([ANSWER]), { profile: PROFILE, search: slow }, { searchTimeoutMs: 10 });
    expect(r.searched).toBe(0);
  });

  it("ignores malformed search results: a non-http URL cannot back a trend", async () => {
    const junk: Search = async () => [{ title: "x", url: "javascript:alert(1)", snippet: "" }, null as never, { title: "ok", url: "https://example.com/linen", snippet: 3 as never }];
    const r = await findOpportunities(fakeAsk([ANSWER]), { profile: PROFILE, search: junk, now: NOW });
    expect(r.searched).toBe(3); // one valid result per query
    expect(r.opportunities[0]!.kind).toBe("trend");
  });

  it("keeps a price idea when the store has prices", async () => {
    const r = await findOpportunities(fakeAsk([ANSWER]), { profile: PROFILE, items: [{ title: "Denim jacket", price: "45 USD" }], search });
    expect(r.opportunities.map((o) => o.kind)).toEqual(["trend", "price", "upsell", "channel"]);
  });

  it("validates estimates: missing or non-numeric is dropped, negative becomes 0, fractions are rounded", async () => {
    const fake = { opportunities: [
      { kind: "upsell", title: "No number", why: "w" },
      { kind: "upsell", title: "Words", why: "w", estimate_usd_month: "a lot" },
      { kind: "upsell", title: "Negative", why: "w", estimate_usd_month: -50 },
      { kind: "channel", title: "Fraction", why: "w", estimate_usd_month: 42.6 },
    ] };
    const r = await findOpportunities(fakeAsk([fake]), { profile: PROFILE }, { maxEstimate: 300 });
    expect(r.opportunities.map((o) => [o.title, o.estimate_usd_month])).toEqual([["Negative", 0], ["Fraction", 43]]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["no numeric estimate", "no numeric estimate"]);
  });

  it("lets a trend rest on real shopper searches", async () => {
    const seen: Message[][] = [];
    const fake = { opportunities: [{ kind: "trend", title: "Shoppers want linen", why: "'linen shirt' searched 40 times", estimate_usd_month: 120, source: "shopper-searches" }] };
    const r = await findOpportunities(fakeAsk([fake], seen), { profile: PROFILE, demand: [{ goods: "linen shirt", searches: 40, empty: 12 }, { goods: "", searches: 3, empty: 0 }] });
    expect(r.opportunities).toHaveLength(1);
    expect(usr(seen[0]!)).toContain("<shopper_searches>");
    const none = await findOpportunities(fakeAsk([fake]), { profile: PROFILE });
    expect(none.opportunities).toEqual([]); // the same source without demand data is not evidence
  });

  it("retries once on malformed output, then fails", async () => {
    const seen: Message[][] = [];
    const r = await findOpportunities(fakeAsk(["Here are some ideas!", { opportunities: [] }], seen), { profile: PROFILE });
    expect(seen).toHaveLength(2);
    expect(r.opportunities).toEqual([]);
    await expect(findOpportunities(fakeAsk([{ ideas: [] }, "nope"]), { profile: PROFILE })).rejects.toThrow(/no valid JSON/);
  });

  it("drops unknown kinds and ideas without evidence", async () => {
    const fake = { opportunities: [{ kind: "giveaway", title: "Free stuff", why: "w", estimate_usd_month: 10 }, { kind: "upsell", title: "", why: "w", estimate_usd_month: 10 }, "junk"] };
    const r = await findOpportunities(fakeAsk([fake]), { profile: PROFILE });
    expect(r.opportunities).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["unknown kind", "no title or evidence", "unknown kind"]);
  });
});
