import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountI18n, parseLangs, pickLang } from "../src/i18n.js";

const page = '<!doctype html><html lang="en"><head><title>Shop</title></head><body><h1>Shop feed</h1></body></html>';
function setup(langs: string) {
  const dir = mkdtempSync(join(tmpdir(), "nc-i18n-"));
  writeFileSync(join(dir, "ru.json"), JSON.stringify({ "Shop feed": "Лента" }));
  const app = new Hono();
  mountI18n(app, { langs: parseLangs(langs), dir, clientJs: "/*client*/", secureCookies: false });
  app.get("/feed", (c) => c.html(page));
  app.get("/api/x", (c) => c.json({ ok: true }));
  return app;
}

describe("review translations (ADR 0029)", () => {
  it("parses UI_LANGS; English is always there; unknown codes are dropped", () => {
    expect(parseLangs(undefined)).toEqual(["en"]);
    expect(parseLangs("ru,uk")).toEqual(["en", "ru", "uk"]);
    expect(parseLangs("en, RU, de")).toEqual(["en", "ru"]);
  });
  it("picks ?lang=, then the cookie, then the browser language, else English", () => {
    const L = ["en", "ru", "uk"];
    expect(pickLang(L, "uk", "ru", "ru-RU")).toBe("uk");
    expect(pickLang(L, undefined, "ru", "uk")).toBe("ru");
    expect(pickLang(L, undefined, undefined, "uk-UA,uk;q=0.9,en;q=0.8")).toBe("uk");
    expect(pickLang(L, undefined, undefined, "de-DE,en;q=0.5")).toBe("en");
    expect(pickLang(L, "xx", undefined, undefined)).toBe("en");
  });
  it("production (English only) leaves pages untouched", async () => {
    const app = setup("en");
    expect(await (await app.request("http://x/feed?lang=ru")).text()).toBe(page);
    expect((await app.request("http://x/assets/i18n/ru.js")).status).toBe(404);
  });
  it("a review build adds the switch and the translator; JSON stays as is", async () => {
    const app = setup("en,ru,uk");
    const r = await app.request("http://x/feed?lang=ru");
    const html = await r.text();
    expect(html).toContain('<html lang="ru"');
    expect(html).toMatch(/<head><script src="\/assets\/i18n\/ru\.js\?v=\w+"><\/script>/);
    expect(html).toContain('class="lang-switch"');
    expect(html).toContain('href="/feed?lang=uk"');
    expect(r.headers.get("set-cookie")).toMatch(/nc_lang=ru/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const js = await (await app.request("http://x/assets/i18n/ru.js")).text();
    expect(js).toContain('"Shop feed":"Лента"');
    expect(js).toContain("/*client*/");
    // English chosen: switch only, no translator.
    const en = await (await app.request("http://x/feed?lang=en")).text();
    expect(en).not.toContain("/assets/i18n/");
    expect(en).toContain('class="lang-switch"');
    expect(await (await app.request("http://x/api/x?lang=ru")).json()).toEqual({ ok: true });
  });
});
