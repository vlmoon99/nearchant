import { describe, expect, it } from "vitest";
import { DEMAND_SOURCE, findOpportunities, findPlace, moderatePost, planSearch, shouldRemove, type Asker } from "../src/index.js";

const asker = (answer: unknown, seen: { role?: string; user?: unknown }[] = []): Asker => (async (role: string, user: unknown) => { seen.push({ role, user }); return answer; }) as Asker;

describe("marketplace agents", () => {
  it("moderator: removes confident violations, keeps unknown categories and weak calls as fine, sends the picture", async () => {
    const seen: { role?: string; user?: unknown }[] = [];
    const v = await moderatePost(asker({ violation: true, category: "counterfeit", confidence: 0.9, summary: "Replica sneakers with a fake logo" }, seen),
      { caption: "1:1 AAA replica", hashtags: ["sneakers"], store: "Shoes", storeDescription: "", image: "data:image/png;base64,AAA", report: { reason: "counterfeit", note: "fake" } });
    expect(v).toMatchObject({ violation: true, category: "counterfeit" });
    expect(shouldRemove(v)).toBe(true);
    expect(seen[0]!.role).toBe("moderator");
    expect((seen[0]!.user as { images: string[] }).images).toEqual(["data:image/png;base64,AAA"]);
    expect(String((seen[0]!.user as { text: string }).text)).toContain("<buyer_report>");
    const odd = await moderatePost(asker({ violation: true, category: "weird", confidence: 2 }), { caption: "x", hashtags: [], store: "s", storeDescription: "" });
    expect(odd).toMatchObject({ violation: false, category: "ok", confidence: 1 });
    expect(shouldRemove(await moderatePost(asker({ violation: true, category: "spam", confidence: 0.4 }), { caption: "x", hashtags: [], store: "s", storeDescription: "" }))).toBe(false);
  });

  it("search planner: cleans terms and place", async () => {
    const p = await planSearch(asker({ goods: ["Protein powder"], terms: ["Protein", "whey", "whey", ""], city: "New York", country: "us", summary: "Protein in New York" }), "protein near me in NYC");
    expect(p).toEqual({ goods: ["protein powder"], terms: ["protein", "whey"], city: "New York", country: "US", summary: "Protein in New York" });
    expect((await planSearch(asker({ country: "USA" }), "x")).country).toBeNull();
  });

  it("place finder: only allowed ships values", async () => {
    expect(await findPlace(asker({ city: "New York", country: "US", ships: "country" }), { name: "Nova", description: "SoHo, ships across the US" })).toEqual({ city: "New York", country: "US", ships: "country" });
    expect((await findPlace(asker({ ships: "galaxy" }), { name: "x", description: "" })).ships).toBeNull();
  });
});

describe("opportunities from shopper demand", () => {
  it("keeps a trend based on Nearchant searches only when there are searches; shows them to the model", async () => {
    const seen: { role?: string; user?: unknown }[] = [];
    const answer = { opportunities: [{ kind: "trend", title: "Linen shirts", why: "12 searches for linen shirt in the US found no store", action: "Post your linen shirt", estimate_usd_month: 80, confidence: "medium", source: DEMAND_SOURCE }] };
    const profile = { products: ["linen shirt"] } as never;
    const withDemand = await findOpportunities(asker(answer, seen), profile, [], undefined, "", [{ goods: "linen shirt", searches: 12, empty: 12 }]);
    expect(withDemand.opportunities.map((o) => o.title)).toEqual(["Linen shirts"]);
    expect(String(seen[0]!.user)).toContain("<shopper_searches>");
    const without = await findOpportunities(asker(answer), profile, [], undefined, "", []);
    expect(without.opportunities).toEqual([]); // no searches → the claim has no source
  });
});
