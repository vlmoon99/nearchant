// Interface text still in English on a review copy (ADR 0029): every text node, also in hidden steps and sheets.
//   node e2e/i18n-misses.mjs <reviewUrl> <sellerSessionToken> <lang> <path…>
import { chromium } from "playwright-core";
const [base, tok, lang, ...paths] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const host = new URL(base).hostname;
await ctx.addCookies([...(tok ? [{ name: "nc_session", value: tok, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }] : []), { name: "nc_lang", value: lang, domain: host, path: "/" }]);
const p = await ctx.newPage(); const all = new Map();
for (const path of paths) {
  await p.goto(base + path, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
  const left = await p.evaluate(() => { const r = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.data.replace(/\s+/g, " ").trim(); const el = n.parentElement; if (!t || !el || el.closest("script,style,[data-no-tr]")) continue; if (/[A-Za-z]{3}/.test(t) && !/[А-Яа-яЇїІіЄєҐґ]/.test(t)) r.push(t); }
    for (const el of document.querySelectorAll("[placeholder],[title],[aria-label]")) for (const a of ["placeholder", "title", "aria-label"]) { const t = el.getAttribute(a); if (t && /[A-Za-z]{3}/.test(t) && !/[А-Яа-яЇїІі]/.test(t)) r.push(`@${a}: ${t}`); }
    return r; });
  for (const t of left) all.set(t, (all.get(t) ?? path));
}
for (const [t, path] of all) console.log(`${path}\t${t.slice(0, 160)}`);
await b.close();
