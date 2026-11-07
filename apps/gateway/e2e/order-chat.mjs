// Order chat + decline & refund end to end (ADR 0024 follow-up): buyer pays in Chrome → writes on the order page →
// the owner reads and replies (session cookie) → the buyer sees the reply → the owner declines & refunds on chain →
// the buyer's page says Refunded.
//   node e2e/order-chat.mjs <storeBase e.g. https://nearchant.com/h/novatestaegk/> <sellerSessionToken> [shotsDir]
import { chromium } from "playwright-core";
const [base, token, shots = "/tmp/nc-chat"] = process.argv.slice(2);
const origin = new URL(base).origin;
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 393, height: 852 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const seller = { headers: { cookie: `nc_session=${token}`, "content-type": "application/json" } };
const api = async (path, body) => { const r = await fetch(`${origin}${path}`, body ? { method: "POST", ...seller, body: JSON.stringify(body) } : seller); return { status: r.status, json: await r.json().catch(() => ({})) }; };

await page.goto(base);
await page.click("a.post"); await page.waitForSelector("form.order");
await page.fill("form.order textarea", "Size M, Jane Doe, 120 Spring St, New York, NY 10012");
await page.click("form.order button");
await page.waitForURL(/\/o\/o-/, { timeout: 180_000 });
const orderId = page.url().match(/o-[\w-]+/)[0]; log(`paid: ${orderId}`);
for (let i = 0; i < 40; i++) { const o = (await api("/api/app/orders")).json.orders?.find((x) => x.orderId === orderId); if (o?.state === "paid") break; await sleep(3000); }

await page.reload(); await page.waitForSelector("[data-chat] input[name=text]", { timeout: 60_000 });
await page.fill("[data-chat] input[name=text]", "Hi! Can you ship to Austin instead?");
await page.click("[data-chat] button[type=submit]");
await page.waitForFunction(() => /ship to Austin/.test(document.querySelector(".chat-log")?.textContent ?? ""), null, { timeout: 15_000 });
log("buyer wrote");
const thread = await api(`/api/app/orders/${orderId}/messages`);
if (!thread.json.messages?.some((m) => m.author === "buyer" && /Austin/.test(m.text))) throw new Error("seller does not see the buyer's message");
log(`seller sees it (chain: ${thread.json.chainStatus})`);
const reply = await api(`/api/app/orders/${orderId}/messages`, { text: "Sorry, we only ship within New York — I'll refund you now." });
if (reply.status !== 200) throw new Error(`reply ${reply.status}`);
await page.waitForFunction(() => /only ship within New York/.test(document.querySelector(".chat-log")?.textContent ?? ""), null, { timeout: 20_000 });
log("buyer sees the reply"); await page.screenshot({ path: `${shots}/chat.png`, fullPage: true });

const refund = await api(`/api/app/orders/${orderId}/refund`, {});
log(`decline & refund: ${refund.status}`);
if (refund.status !== 202) throw new Error(JSON.stringify(refund.json));
for (let i = 0; i < 40; i++) { await sleep(4000); await page.reload(); if (/Refunded/.test(await page.innerText("body"))) break; }
if (!/Refunded/.test(await page.innerText("body"))) throw new Error("the buyer's page never said Refunded");
log("buyer page: Refunded"); await page.screenshot({ path: `${shots}/refunded.png`, fullPage: true });
const order = (await api("/api/app/orders")).json.orders?.find((x) => x.orderId === orderId);
log(`seller's order state: ${order?.state}`);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
