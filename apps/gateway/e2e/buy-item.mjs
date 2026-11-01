// Store item end to end: buyer pays in Chrome → owner marks shipped (session cookie) → buyer confirms → Released.
//   node e2e/buy-item.mjs <storeBase e.g. https://nearchant.com/h/novatestaegk/> <sellerSessionToken> [shotsDir]
import { chromium } from "playwright-core";
const [base, token, shots = "/tmp/nc-item"] = process.argv.slice(2);
const origin = new URL(base).origin;
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(base); await page.screenshot({ path: `${shots}/store.png`, fullPage: true });
await page.click("a.post"); await page.waitForSelector("form.order");
await page.fill("form.order textarea", "Size M, Jane Doe, 120 Spring St, New York, NY 10012, +1 212 555 0100");
await page.screenshot({ path: `${shots}/item.png`, fullPage: true });
await page.click("form.order button");
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
log("accepted → Released"); await page.screenshot({ path: `${shots}/released.png`, fullPage: true });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
