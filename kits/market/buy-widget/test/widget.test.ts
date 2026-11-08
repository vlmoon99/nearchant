import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cssUrl, renderCards, renderMissing, renderWidget, safeUrl, WIDGET_CSS, type WidgetItem } from "../src/index.js";

const store = { name: "Ann's <Bakery>", url: "https://shop.example/ann/" };
const buyUrl = (i: WidgetItem) => `https://shop.example/ann/i/${i.id}?ref=widget`;
const cake: WidgetItem = { id: "cake", title: "Cake", price: "12 USDC", img: "https://img.example/c.jpg", facts: ["In stock", "Pickup only"] };

describe("renderWidget", () => {
  it("renders one item with a Buy button that opens a new tab", () => {
    const html = renderWidget({ items: [cake], store, buyUrl });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('class="nw-one"');
    expect(html).toContain('<a class="nw-btn" href="https://shop.example/ann/i/cake?ref=widget" target="_blank" rel="noopener">Buy · 12 USDC</a>');
    expect(html).toContain("In stock · Pickup only");
    expect(html).toContain("<title>Cake · Ann&#39;s &lt;Bakery&gt;</title>");
    expect(html).toContain('<script src="/embed-frame.js" defer></script>');
    expect(html).toContain(`<style>${WIDGET_CSS}</style>`);
  });

  it("escapes everything a seller typed", () => {
    const evil: WidgetItem = { id: '"><x', title: '<img src=x onerror="alert(1)">', price: "<b>1</b>", img: "https://e.x/a.jpg');background:url('//evil", facts: ["<script>"] };
    const html = renderCards({ items: [evil], store: { name: "<s>", url: "javascript:alert(1)" }, buyUrl: () => "javascript:alert(1)" });
    expect(html).not.toMatch(/<img|<script|<b>|<s>/);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('href="#"');
    // The image URL can't close url('…') or the attribute.
    expect(html).toMatch(/background-image:url\('https:\/\/e\.x\/a\.jpg%27%29;background:url%28%27\/\/evil'\)/);
  });

  it("shows sold-out items without a buy link", () => {
    const html = renderCards({ items: [{ ...cake, soldOut: true }], store, buyUrl });
    expect(html).toContain('<span class="nw-btn secondary" aria-disabled="true">Sold out</span>');
    expect(html).not.toContain('class="nw-btn" href');
    expect(html).toContain('<span class="nw-cap nw-muted nw-clamp1">Sold out</span>');
    expect(html).toContain("nw-card sold-out");
  });

  it("says Book for services and From for price ranges, grid for many", () => {
    const html = renderCards({ items: [cake, { id: "c", title: "Class", price: "5 USDC", kind: "service", priceFrom: true }], store, buyUrl });
    expect(html).toContain('class="nw-grid"');
    expect(html).toContain(">Book · 5 USDC</a>");
    expect(html).toContain('<span class="nw-price">From 5 USDC</span>');
  });

  it("says when there is nothing for sale", () => {
    expect(renderCards({ items: [], store, buyUrl })).toContain("Nothing for sale right now.");
    expect(renderMissing()).toContain("isn&#39;t for sale");
  });

  it("supports theme, labels, own stylesheet and no frame script", () => {
    const html = renderWidget({ items: [cake], store, buyUrl, theme: "dark", cssHref: "/w.css", frameScriptSrc: null, labels: { buy: "Kaufen" }, lang: "de" });
    expect(html).toContain('<html lang="de" data-theme="dark">');
    expect(html).toContain('<link rel="stylesheet" href="/w.css">');
    expect(html).not.toContain("<script");
    expect(html).toContain(">Kaufen · 12 USDC<");
  });

  it("widget.css and the inlined WIDGET_CSS are the same", () => {
    expect(readFileSync(new URL("../widget.css", import.meta.url), "utf8")).toBe(WIDGET_CSS);
  });
});

describe("urls", () => {
  it("allows only http(s) and paths", () => {
    expect(safeUrl("/i/1")).toBe("/i/1");
    expect(safeUrl("https://a.b/c")).toBe("https://a.b/c");
    expect(safeUrl("//evil.example")).toBe("#");
    expect(safeUrl(" JavaScript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,x")).toBe("#");
    expect(cssUrl("https://a.b/x y(1).jpg")).toBe("https://a.b/x%20y%281%29.jpg");
  });
});
