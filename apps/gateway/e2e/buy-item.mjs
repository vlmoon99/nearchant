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
const ship = await fetch(`${origin}/api/app/orders/${orderId}/ship`, { method: "POST", ...seller, body: JSON.stringify({ note: "UPS 1Z999AA10123456784" }) });
log(`ship: ${ship.status}`);
await page.reload(); await page.waitForSelector("button[data-order-action=accept]", { timeout: 300_000 });
log("delivered on chain"); await page.screenshot({ path: `${shots}/delivered.png`, fullPage: true });
await page.click("button[data-order-action=accept]");
await page.waitForFunction(() => /Released|Done — thank you/.test(document.body.innerText), null, { timeout: 180_000 });
log("accepted → Released");
const sellerPage = await (await fetch(`${origin}/app/orders/${orderId}`, seller)).text();
log(`seller sees the buyer's WhatsApp: ${sellerPage.includes("https://wa.me/12125550100")}`);
log(`buyer sees the store's contact: ${/Contact [^<]+<\/span>\s*<div class="list"><div class="list-row"><a/.test(await page.content())}`); await page.screenshot({ path: `${shots}/released.png`, fullPage: true });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
