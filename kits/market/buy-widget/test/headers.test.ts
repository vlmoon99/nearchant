import { describe, expect, it } from "vitest";
import { isWidgetPath, loaderHeaders, widgetHeaders } from "../src/index.js";

describe("widgetHeaders", () => {
  it("lets any page frame the widget (no frame-ancestors, no X-Frame-Options)", () => {
    const h = widgetHeaders();
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    expect(keys).not.toContain("x-frame-options");
    expect(h["content-security-policy"]).not.toMatch(/frame-ancestors/);
    expect(h["content-security-policy"]).toContain("script-src 'self'");
    expect(h["content-type"]).toBe("text/html; charset=utf-8");
  });
  it("adds image and script origins", () => {
    const csp = widgetHeaders({ imgSrc: ["https://cdn.example"], scriptSrc: ["https://js.example"] })["content-security-policy"];
    expect(csp).toContain("img-src 'self' data: https: https://cdn.example");
    expect(csp).toContain("script-src 'self' https://js.example");
  });
  it("serves the loader cross-origin", () => {
    expect(loaderHeaders()["access-control-allow-origin"]).toBe("*");
    expect(loaderHeaders()["content-type"]).toMatch(/javascript/);
  });
  it("matches widget paths", () => {
    expect(isWidgetPath("/embed/ann")).toBe(true);
    expect(isWidgetPath("/embed")).toBe(true);
    expect(isWidgetPath("/embedded")).toBe(false);
    expect(isWidgetPath("/h/ann/embed/i/1", "/h/ann/embed")).toBe(true);
  });
});
