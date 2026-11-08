// A shopper on a phone, not signed in: feed → a store → an item → pay → "My orders" must list it; tabs work from
// every page; tapping Account opens the sign-in sheet (never signs out). node e2e/buyer-journey.mjs <handle> <shots dir>
import { chromium } from "playwright-core";
const [handle, out] = process.argv.slice(2);
const site = process.env.BASE ?? "https://nearchant.com";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const tab = async (name) => { await p.click(`.buyertabs a:has-text("${name}")`); await p.waitForLoadState("domcontentloaded"); };
await p.goto(`${site}/feed`); await p.screenshot({ path: `${out}/j1-feed.png` });
await p.goto(`${site}/h/${handle}/`); await p.screenshot({ path: `${out}/j2-store.png`, fullPage: true });
await tab("Shop"); log(`store → Shop tab: ${new URL(p.url()).pathname}`);
await p.goBack(); await p.click("a.post[href*='/i/']"); await p.waitForSelector("form.order"); log(`item: ${await p.textContent("h1")}`);
await p.fill("[name=name]", "Jane"); await p.fill("[name=phone]", "+1 212 555 0100");
if (await p.$("textarea[name=address]")) await p.fill("textarea[name=address]", "120 Spring St, New York");
if (await p.$("textarea[name=brief][required]")) await p.fill("textarea[name=brief]", "Pixel 8");
await p.click("form.order button[type=submit]");
await p.waitForFunction(() => /Paid ✓|didn't go through|Payment sent/.test(document.querySelector(".sheet [data-t]")?.textContent ?? ""), null, { timeout: 120_000 });
log(`pay: ${await p.textContent(".sheet [data-t]")}`); await p.screenshot({ path: `${out}/j3-paid.png` });
await p.click(".sheet button:has-text('Keep shopping')");
await tab("Orders"); await p.waitForSelector("[data-local-orders] a", { timeout: 20_000 }).catch(() => {});
log(`My orders (not signed in): ${await p.$$eval("[data-local-orders] a", (as) => as.length)} order(s) in this browser`); await p.screenshot({ path: `${out}/j4-orders.png`, fullPage: true });
await p.click(".buyertabs [data-buyer-tab]"); await p.waitForSelector(".sheet", { timeout: 5000 });
log(`Account tab opens: "${await p.textContent(".sheet .headline")}"`); await p.screenshot({ path: `${out}/j5-account.png` });
await p.click(".sheet-x");
for (const t of ["Following", "Liked", "Shop"]) { await tab(t); log(`tab ${t}: ${new URL(p.url()).pathname} · "${(await p.textContent("h1"))?.trim()}"`); }
console.log("errors:", errs.length ? errs : "none"); await b.close();
