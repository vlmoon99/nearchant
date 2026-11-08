import { describe, expect, it } from "vitest";
import { analyzeStore, factsFromProfile, shapeProfile, type Ask, type Message } from "../src/index.js";

/** A fake model: returns the canned answers in order and records what it was sent. No network. */
function fakeAsk(answers: unknown[], seen: Message[][] = []): Ask {
  return async (messages) => { seen.push(messages); const a = answers.shift(); return typeof a === "string" ? a : JSON.stringify(a); };
}

const RAW = {
  business_name: "Nova Wear", summary: "Relaxed clothes made in Kyiv", customers: "Women and men 25–34", tone: "warm, friendly, a little playful",
  best_days: ["Friday", "Saturday", "Funday", "Friday"], brand_colors: ["#2b3d80", "#f0dcbc", "not-a-color", "#fff"],
  products: [{ name: "Denim jacket", photo: 1, description: "light wash", category: "denim" }, { name: "Linen shirt", photo: 9, description: "sand", category: "linen" }, { name: "", photo: 2 }, "junk"],
  content_pillars: ["new drops", "styling tips"], visual_style: "natural light", best_post_hint: "Close-ups of the stitching get saved", avoid: ["discount spam"],
  price_list: "the model made this up",
};

describe("shapeProfile", () => {
  it("validates days, colours, photo numbers and drops nameless products", () => {
    const p = shapeProfile(RAW, "Fallback", 2);
    expect(p.best_days).toEqual(["Friday", "Saturday"]);
    expect(p.brand_colors).toEqual(["#2b3d80", "#f0dcbc"]);
    expect(p.products.map((x) => [x.name, x.photo])).toEqual([["Denim jacket", 1], ["Linen shirt", null]]);
    expect(p).not.toHaveProperty("price_list");
  });

  it("never throws on garbage and keeps the given name", () => {
    for (const g of ["nope", null, 42, [], { products: "x", best_days: "Monday" }]) {
      const p = shapeProfile(g, "Nova", 3);
      expect(p.business_name).toBe("Nova");
      expect(p.products).toEqual([]);
      expect(p.best_days).toEqual([]);
    }
  });

  it("caps long strings", () => {
    expect(shapeProfile({ summary: "x".repeat(5000), tone: "y".repeat(500) }, "N", 0).summary).toHaveLength(400);
  });
});

describe("factsFromProfile", () => {
  it("summarises products, style, buyers and best posts", () => {
    const f = factsFromProfile(shapeProfile(RAW, "N", 2));
    expect(f.map((x) => x.title)).toEqual(["Found 2 products", "Your style", "Your buyers", "Your best posts"]);
    expect(f[0]!.detail).toBe("denim, linen");
  });

  it("falls back to best days and handles an empty profile", () => {
    expect(factsFromProfile(shapeProfile({ best_days: ["Monday"] }, "N", 0))).toEqual([{ title: "Best days to post", detail: "Monday" }]);
    expect(factsFromProfile(shapeProfile({}, "N", 0))).toEqual([]);
  });
});

describe("analyzeStore", () => {
  it("sends the photos as image parts with the rules and returns profile + facts", async () => {
    const seen: Message[][] = [];
    const photos = ["data:image/jpeg;base64,AAA", "https://example.com/b.jpg", "file:///etc/passwd"];
    const r = await analyzeStore(fakeAsk([RAW], seen), { name: "Nova Wear", kind: "clothes", description: "Relaxed clothes" }, photos);
    const [system, user] = seen[0]!;
    expect(system!.content).toContain("never invent prices");
    expect(system!.content).toContain("data from the business owner");
    const parts = user!.content as { type: string; text?: string }[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2); // the file: URL is not sent
    expect(parts[0]!.text).toContain("numbered 1 to 2");
    expect(r.photosUsed).toBe(2);
    expect(r.profile.products[0]!.photo).toBe(1);
    expect(r.facts[0]!.title).toBe("Found 2 products");
  });

  it("works without photos (text only, photo numbers null)", async () => {
    const seen: Message[][] = [];
    const r = await analyzeStore(fakeAsk([RAW], seen), { description: "Relaxed clothes" });
    expect(typeof seen[0]![1]!.content).toBe("string");
    expect(r.profile.products.every((p) => p.photo === null)).toBe(true);
  });

  it("keeps at most maxPhotos", async () => {
    const seen: Message[][] = [];
    await analyzeStore(fakeAsk([RAW], seen), { description: "d" }, Array(12).fill("data:image/png;base64,A"), { maxPhotos: 3 });
    expect((seen[0]![1]!.content as unknown[]).length).toBe(4);
  });

  it("retries once on malformed or empty output, then fails", async () => {
    const seen: Message[][] = [];
    const r = await analyzeStore(fakeAsk(["I think it is a clothes shop", RAW], seen), { name: "Nova", description: "d" });
    expect(seen).toHaveLength(2);
    expect(r.profile.business_name).toBe("Nova Wear");
    await expect(analyzeStore(fakeAsk([{ foo: 1 }, { products: [] }]), { description: "d" })).rejects.toThrow(/no summary, products or tone/);
  });

  it("does not hide a failing model", async () => {
    await expect(analyzeStore(async () => { throw new Error("endpoint down"); }, { description: "d" })).rejects.toThrow("endpoint down");
  });
});
