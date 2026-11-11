// Review translations (ADR 0029). UI_LANGS="en,ru,uk" turns on Russian and Ukrainian for a review copy of the site:
// a language switch on every page, and web/i18n.ts translating the interface from i18n/<lang>.json. Production
// leaves UI_LANGS unset (English only): then this adds nothing to any page.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const LANG_LABEL: Record<string, string> = { en: "EN", ru: "RU", uk: "UA" };
const COOKIE = "nc_lang";

export function parseLangs(v: string | undefined): string[] {
  const xs = (v ?? "en").split(",").map((x) => x.trim().toLowerCase()).filter((x) => x in LANG_LABEL);
  return xs.includes("en") ? [...new Set(xs)] : ["en", ...new Set(xs)];
}

/** The language for this request: ?lang= (remembered), the cookie, then the browser's languages; English otherwise. */
export function pickLang(langs: string[], q: string | undefined, cookie: string | undefined, accept: string | undefined): string {
  for (const x of [q, cookie]) if (x && langs.includes(x)) return x;
  for (const part of (accept ?? "").split(",")) {
    const code = part.split(";")[0]!.trim().toLowerCase().slice(0, 2);
    if (code === "en") return "en";
    if (langs.includes(code)) return code;
  }
  return "en";
}

/** The switch, fixed on every page. Links keep the page and set ?lang=. */
export function switchHtml(langs: string[], lang: string, path: string, search: string): string {
  const qs = new URLSearchParams(search); qs.delete("lang");
  const href = (l: string) => { const p = new URLSearchParams(qs); p.set("lang", l); return `${path}?${p.toString()}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); };
  return `<nav class="lang-switch" data-no-tr aria-label="Language">${langs.map((l) => `<a href="${href(l)}" hreflang="${l}"${l === lang ? ' class="on" aria-current="true"' : ""}>${LANG_LABEL[l]}</a>`).join("")}</nav>`;
}

/** Adds the language switch and the translator to HTML pages. No-op with English only. */
export function mountI18n(app: Hono<any>, o: { langs: string[]; dir: string; clientJs: string | undefined; secureCookies: boolean }): void {
  if (o.langs.length < 2) return;
  const scripts = new Map<string, { body: string; v: string }>();
  for (const l of o.langs.filter((x) => x !== "en")) {
    const file = join(o.dir, `${l}.json`);
    const dict = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
    const body = `window.__ncI18n=${JSON.stringify({ lang: l, langs: o.langs, dict }).replaceAll("<", "\\u003c")};\n${o.clientJs ?? ""}`;
    scripts.set(l, { body, v: createHash("sha256").update(body).digest("hex").slice(0, 12) });
  }
  app.get("/assets/i18n/:file", (c) => {
    const s = scripts.get(c.req.param("file").replace(/\.js$/, ""));
    return s ? c.body(s.body, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }) : c.notFound();
  });
  app.use("*", async (c, next) => {
    const q = c.req.query("lang");
    if (q && o.langs.includes(q)) setCookie(c, COOKIE, q, { path: "/", maxAge: 365 * 24 * 3600, sameSite: "Lax", secure: o.secureCookies });
    await next();
    if (!(c.res.headers.get("content-type") ?? "").startsWith("text/html")) return;
    const lang = pickLang(o.langs, q, getCookie(c, COOKIE), c.req.header("accept-language"));
    const html = await c.res.text();
    const url = new URL(c.req.url);
    const s = scripts.get(lang);
    let out = html.replace(/<html lang="en"/, `<html lang="${lang}"`);
    out = s ? out.replace(/<head>/i, `<head><script src="/assets/i18n/${lang}.js?v=${s.v}"></script>`) : out;
    // A slim bar at the very top (scrolls away), so it never covers a button.
    const sw = `${switchHtml(o.langs, lang, url.pathname, url.search)}<style>.lang-switch{display:flex;justify-content:center;gap:4px;padding:5px 8px;background:var(--fill,#f2f2f7);border-bottom:.5px solid var(--sep,#ddd);font:600 12px/1 -apple-system,system-ui,sans-serif}.lang-switch a{padding:5px 12px;border-radius:999px;color:var(--label,#000);text-decoration:none}.lang-switch a.on{background:var(--blue,#007aff);color:#fff}</style>`;
    out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => `${m}${sw}`) : sw + out;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    headers.set("vary", "Cookie, Accept-Language");
    headers.set("cache-control", "private, no-store");
    c.res = new Response(out, { status: c.res.status, headers });
  });
}
