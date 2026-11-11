import { chromium } from "playwright-core";
const [base, out, tok, lang] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
await ctx.addCookies([{ name: "nc_session", value: tok, domain: new URL(base).hostname, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }, { name: "nc_lang", value: lang, domain: new URL(base).hostname, path: "/" }]);
const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const pages = ["/", "/feed", "/h/supernutrition/", "/start", "/app", "/app/shop", "/app/orders", "/app/settings", "/app/posts", "/app/analytics", "/app/wallet", "/feed/orders", "/verify"];
for (const path of pages) {
  await p.goto(base + path, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500);
  const left = await p.evaluate(() => { const r = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.data.trim(); const el = n.parentElement; if (!t || !el || el.closest("script,style,[data-no-tr]")) continue; const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || !el.getClientRects().length) continue; if (/[A-Za-z]{3}/.test(t) && !/[А-Яа-яЇїІіЄєҐґ]/.test(t)) r.push(t.slice(0, 60)); } return [...new Set(r)]; });
  console.log(`${path}  english left: ${left.length}  ${JSON.stringify(left.slice(0, 25))}`);
  await p.screenshot({ path: `${out}/${lang}${path.replace(/\//g, "_") || "_"}.png`, fullPage: false });
}
console.log("errors:", errs.length ? errs : "none");
await b.close();
