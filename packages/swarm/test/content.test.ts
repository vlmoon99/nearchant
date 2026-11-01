import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { analyzeBusiness, factsFromProfile, findOpportunities, loadAgentEnv, shapeProfile, type Asker } from "../src/index.js";

const env = loadAgentEnv(join(import.meta.dirname, "../../../envs/content-store"));

function fakeAsk(answers: Record<string, unknown>, seen: { role: string; user: unknown }[] = []): Asker {
  return (async (role: string, user: unknown) => { seen.push({ role, user }); return answers[role]; }) as Asker;
}

const PROFILE = {
  business_name: "Nova Wear", summary: "Relaxed clothes made in Kyiv", customers: "Women and men 25–34 in Kyiv", tone: "warm, friendly, a little playful",
  best_days: ["Friday", "Saturday", "Funday"], brand_colors: ["#2b3d80", "#f0dcbc", "not-a-color"],
  products: [{ name: "Denim jacket", photo: 1, description: "light wash", category: "denim" }, { name: "Linen shirt", photo: 9, description: "sand", category: "linen" }, { name: "", photo: 2 }],
  content_pillars: ["new drops", "styling tips"], visual_style: "natural light", best_post_hint: "Model shots get the most saves", avoid: ["discount spam"],
};

describe("content env", () => {
  it("loads all six roles with the shared rules", () => {
    expect(Object.keys(env.roles).sort()).toEqual(["idea-writer", "insight-writer", "learner", "localizer", "opportunity-analyst", "profiler"]);
    expect(env.roles.profiler!.system).toContain("never invent prices");
    expect(env.roles.profiler!.system).toContain("data from the business owner");
  });
});

describe("analyzeBusiness", () => {
  it("sends the photos to the vision role and shapes the profile", async () => {
    const seen: { role: string; user: any }[] = [];
    const p = await analyzeBusiness(fakeAsk({ profiler: PROFILE }, seen), { name: "Nova Wear", kind: "products", description: "d", links: [] }, ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]);
    expect(seen[0]!.user.images).toHaveLength(2);
    expect(seen[0]!.user.text).toContain("numbered 1 to 2");
    expect(p.best_days).toEqual(["Friday", "Saturday"]);
    expect(p.brand_colors).toEqual(["#2b3d80", "#f0dcbc"]);
    expect(p.products.map((x) => x.photo)).toEqual([1, null]); // photo 9 doesn't exist; the nameless product is dropped
  });

  it("keeps the given name when the model returns garbage", () => {
    expect(shapeProfile("nope", "Nova", 0).business_name).toBe("Nova");
  });

  it("turns the profile into the facts the onboarding screen shows", () => {
    const f = factsFromProfile(shapeProfile(PROFILE, "Nova", 2));
    expect(f.map((x) => x.title)).toEqual(["Found 2 products", "Your style", "Your buyers", "Your best posts"]);
    expect(f[0]!.detail).toBe("denim, linen");
  });
});

describe("findOpportunities", () => {
  const profile = shapeProfile(PROFILE, "Nova", 2);
  const results = [{ title: "Linen is back", url: "https://example.com/linen", snippet: "searches up 40%" }];
  const answer = { opportunities: [
    { kind: "trend", title: "Linen is trending", why: "Searches +40%", action: "Post linen Friday", estimate_usd_month: 180, confidence: "medium", source: "https://example.com/linen" },
    { kind: "trend", title: "Second trend", why: "dup kind", source: "https://example.com/linen" },
    { kind: "price", title: "Denim at 49", why: "below similar", estimate_usd_month: 90 },
    { kind: "upsell", title: "Denim + tee bundle", why: "buyers add a tee", estimate_usd_month: 99999 },
    { kind: "channel", title: "Telegram shop", why: "buyers there", source: "https://made-up.example/x" },
  ] };

  it("keeps one per kind, caps estimates and drops price claims without the store's prices", async () => {
    const { opportunities, searched } = await findOpportunities(fakeAsk({ "opportunity-analyst": answer }), profile, [], async () => results);
    expect(searched).toBe(3); // one result per query, 3 queries
    expect(opportunities.map((o) => o.kind)).toEqual(["trend", "upsell", "channel"]);
    expect(opportunities.find((o) => o.kind === "upsell")!.estimate_usd_month).toBe(1000);
  });

  it("drops a trend that cites no real search result", async () => {
    const fake = { opportunities: [{ kind: "trend", title: "Invented trend", why: "w", source: "https://nowhere.example" }] };
    const { opportunities } = await findOpportunities(fakeAsk({ "opportunity-analyst": fake }), profile, [], async () => results);
    expect(opportunities).toEqual([]);
  });

  it("allows a price opportunity when the store has prices", async () => {
    const { opportunities } = await findOpportunities(fakeAsk({ "opportunity-analyst": answer }), profile, [{ title: "Denim jacket", price: "45 nUSD" }], async () => results);
    expect(opportunities.map((o) => o.kind)).toContain("price");
  });
});
