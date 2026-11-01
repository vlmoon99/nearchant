// End-to-end in a real browser (installed Google Chrome): order a deck from alice, pay with a sponsored
// testnet wallet, wait for the agents, accept. Needs gateway + worker running (scripts/dev.sh).
//   node e2e/buy-deck.mjs [baseUrl]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://alice.localhost:8787/";
const revise = process.argv.includes("--revise"); // ask for one revision before accepting
const brief = "Seed pitch deck for BeanBox: a specialty coffee subscription in Kyiv, 18 EUR a month, 400 paying subscribers after 6 months, two founders (a roaster and a growth marketer), raising 300k EUR to open a second roastery.";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

await page.goto(base);
log(`card: ${await page.locator("h1").first().textContent()}`);
await page.fill("form.order textarea", brief);
await page.click("form.order button");
await page.waitForURL(/\/o\/o-/, { timeout: 180_000 });
const orderUrl = page.url();
log(`paid, order page: ${orderUrl}`);

// Agents work: the page refreshes itself; wait for the delivered deck (up to 25 min).
await page.waitForSelector("button[data-order-action=accept]", { timeout: 25 * 60_000 });
log(`delivered: ${await page.locator("p.account").textContent()}`);
const links = await page.locator("a.dl").evaluateAll((as) => as.map((a) => a.href));
log(`downloads: ${links.join(", ")}`);
if (revise) {
  await page.fill("#revision-note", "Add a slide on the subscription retention plan and make the ask slide more concrete.");
  await page.click("button[data-order-action=request_revision]");
  await page.waitForSelector("text=Agents are working", { timeout: 30 * 60_000 }); // escrow timer picks it up (≤10 min)
  log("revision requested; agents are reworking");
  await page.waitForSelector("button[data-order-action=accept]", { timeout: 30 * 60_000 });
  log(`redelivered: ${await page.locator("p.account").textContent()}`);
}
await page.click("button[data-order-action=accept]");
await page.waitForSelector("text=Accepted", { timeout: 120_000 });
log(`accepted: ${await page.locator("p.account").textContent()}`);
await page.screenshot({ path: "../../.media/e2e-order.png", fullPage: true });
if (errors.length) console.log("page errors:", errors);
await browser.close();
