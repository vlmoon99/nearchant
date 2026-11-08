// The seller taps "Mark shipped" and leaves the order page at once: the progress must follow them (bar on every app
// page, time counted from the tap) and end with the result, and the Orders list must show the new state.
//   node e2e/ship-leave.mjs <storeBase e.g. https://nearchant.com/h/novatestaegk/> <sellerSessionToken> [shotsDir]
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
// Pay with nothing filled in: the missing fields are marked and named, no payment starts.
await page.click("form.order button[type=submit]");
await page.waitForSelector(".list-field.invalid", { timeout: 5000 });
log(`empty form says: "${await page.textContent("form.order output")}"`); await page.screenshot({ path: `${shots}/item-invalid.png`, fullPage: true });
// ADR 0026: the buyer leaves a way to reach them (phone + app or email) and, for things that ship, an address.
await page.fill("form.order textarea[name=brief]", "Size M please");
await page.fill("form.order input[name=name]", "Jane Doe");
await page.fill("form.order input[name=phone]", "+1 212 555 0100");
if (await page.$("form.order textarea[name=address]")) await page.fill("form.order textarea[name=address]", "120 Spring St, New York, NY 10012");
await page.screenshot({ path: `${shots}/item.png`, fullPage: true });
await page.click("form.order button[type=submit]");
await page.waitForSelector(".sheet .steps li.now", { timeout: 15_000 });
log(`sheet: "${await page.textContent(".sheet [data-t]")}" — ${await page.textContent(".sheet .steps li.now")}`); await page.screenshot({ path: `${shots}/paying.png` });
await page.waitForFunction(() => /Paid ✓|didn't go through|Payment sent/.test(document.querySelector(".sheet [data-t]")?.textContent ?? ""), null, { timeout: 180_000 });
log(`sheet: "${await page.textContent(".sheet [data-t]")}" — ${(await page.textContent(".sheet [data-m]")).replace(/\s+/g, " ")}`); await page.screenshot({ path: `${shots}/paid.png` });
log(`balance pill: ${await page.textContent("[data-pay-balance]").catch(() => "none")}`);
await page.click(".sheet a.btn");
await page.waitForURL(/\/o\/o-/, { timeout: 30_000 });
const orderId = page.url().match(/o-[\w-]+/)[0]; log(`paid: ${orderId}`);
const seller = { headers: { cookie: `nc_session=${token}`, "content-type": "application/json" } };
for (let i = 0; i < 30; i++) { const o = (await (await fetch(`${origin}/api/app/orders`, seller)).json()).orders.find((x) => x.orderId === orderId); if (o?.state === "paid") break; await new Promise((r) => setTimeout(r, 3000)); }
const sctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
await sctx.addCookies([{ name: "nc_session", value: token, domain: new URL(base).hostname, path: "/", secure: base.startsWith("https"), httpOnly: true }]);
const sp = await sctx.newPage(); sp.on("pageerror", (e) => errors.push(`seller: ${e.message}`));
await sp.goto(`${origin}/app/orders/${orderId}`);
await sp.click(`[data-ship="${orderId}"]`);
await sp.waitForTimeout(1200);
await sp.goto(`${origin}/app/orders`); log("left for the Orders list");
await sp.waitForSelector(".actbar .live", { timeout: 10_000 });
log(`bar: "${await sp.textContent(".actbar .live")}" · row pill: "${await sp.textContent(`[data-order-row="${orderId}"] .pill`)}"`); await sp.screenshot({ path: `${shots}/leave-bar.png` });
await sp.waitForTimeout(4000);
await sp.goto(`${origin}/app`).catch(() => {}); // another page: the bar keeps counting from the tap
await sp.waitForSelector(".actbar .live", { timeout: 10_000 }).catch(() => {});
log(`home bar: "${await sp.textContent(".actbar .live").catch(() => "(already done)")}"`); await sp.screenshot({ path: `${shots}/leave-home.png` });
await sp.waitForFunction(() => /✓|didn't go through/.test(document.querySelector(".actbar")?.textContent ?? ""), null, { timeout: 300_000 }).catch(() => {});
log(`result: "${await sp.textContent(".actbar").catch(() => "(bar gone)")}"`); await sp.screenshot({ path: `${shots}/leave-done.png` });
await sp.goto(`${origin}/app/orders`);
log(`list pill now: "${await sp.textContent(`[data-order-row="${orderId}"] .pill`)}"`); await sp.screenshot({ path: `${shots}/leave-list.png` });
console.log(errors.length ? `PAGE ERRORS: ${errors.join(" | ")}` : "no page errors");
await browser.close();
