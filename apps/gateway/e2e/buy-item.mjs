// Store item end to end: buyer pays in Chrome → owner marks shipped (session cookie) → buyer confirms → Released.
//   node e2e/buy-item.mjs <storeBase e.g. https://nearchant.com/h/novatestaegk/> <sellerSessionToken> [shotsDir]
//   BUYER_COOKIE=<nc_buyer token> → buys as a signed-in buyer (the order then shows in /feed/orders)
import { chromium } from "playwright-core";
const [base, token, shots = "/tmp/nc-item"] = process.argv.slice(2);
const origin = new URL(base).origin;
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
if (process.env.BUYER_COOKIE) await ctx.addCookies([{ name: "nc_buyer", value: process.env.BUYER_COOKIE, domain: new URL(base).hostname, path: "/", secure: base.startsWith("https"), httpOnly: true }]);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(base); await page.screenshot({ path: `${shots}/store.png`, fullPage: true });
await page.click("a.post"); await page.waitForSelector("form.order");
// ADR 0026: the buyer leaves a way to reach them (phone + app or email) and, for things that ship, an address.
await page.fill("form.order textarea[name=brief]", "Size M please");
await page.fill("form.order input[name=name]", "Jane Doe");
await page.fill("form.order input[name=phone]", "+1 212 555 0100");
if (await page.$("form.order textarea[name=address]")) await page.fill("form.order textarea[name=address]", "120 Spring St, New York, NY 10012");
await page.screenshot({ path: `${shots}/item.png`, fullPage: true });
await page.click("form.order button[type=submit]");
await page.waitForURL(/\/o\/o-/, { timeout: 180_000 });
const orderId = page.url().match(/o-[\w-]+/)[0]; log(`paid: ${orderId}`);
const seller = { headers: { cookie: `nc_session=${token}`, "content-type": "application/json" } };
for (let i = 0; i < 30; i++) { const o = (await (await fetch(`${origin}/api/app/orders`, seller)).json()).orders.find((x) => x.orderId === orderId); if (o?.state === "paid") break; await new Promise((r) => setTimeout(r, 3000)); }
// The seller clicks "Mark shipped" in the app; neither page is reloaded by this script — both must update by themselves.
const sctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
await sctx.addCookies([{ name: "nc_session", value: token, domain: new URL(base).hostname, path: "/", secure: base.startsWith("https"), httpOnly: true }]);
const sp = await sctx.newPage(); sp.on("pageerror", (e) => errors.push(`seller: ${e.message}`));
await sp.goto(`${origin}/app/orders/${orderId}`);
await sp.fill(`[data-ship-note="${orderId}"]`, "UPS 1Z999AA10123456784");
await sp.click(`[data-ship="${orderId}"]`);
await sp.waitForSelector("[data-live]:not(.hidden)", { timeout: 10_000 });
log(`seller sees: "${await sp.textContent("[data-live-text]")}"`); await sp.screenshot({ path: `${shots}/seller-live.png` });
await sp.waitForFunction(() => document.querySelector("[data-live-order]")?.getAttribute("data-label") === "Shipped", null, { timeout: 300_000 });
log("seller page shows Shipped by itself"); await sp.screenshot({ path: `${shots}/seller-shipped.png` });
await page.waitForSelector("button[data-order-action=accept]", { timeout: 120_000 });
log("buyer page shows Shipped by itself");
log("delivered on chain"); await page.screenshot({ path: `${shots}/delivered.png`, fullPage: true });
await page.click("button[data-order-action=accept]");
await page.waitForFunction(() => /Released|Done — thank you/.test(document.body.innerText), null, { timeout: 180_000 });
log("accepted → Released");
const sellerPage = await (await fetch(`${origin}/app/orders/${orderId}`, seller)).text();
log(`seller sees the buyer's WhatsApp: ${sellerPage.includes("https://wa.me/12125550100")}`);
log(`buyer sees the store's contact: ${/Contact [^<]+<\/span>\s*<div class="list"><div class="list-row"><a/.test(await page.content())}`); await page.screenshot({ path: `${shots}/released.png`, fullPage: true });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
