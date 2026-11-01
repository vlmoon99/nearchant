// Onboarding end to end in Chrome at phone size: /start → store → photos → analysis → opportunities → posts → live.
//   node e2e/onboard.mjs [baseUrl] [photosDir] [shotsDir]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://nearchant.com";
const photosDir = process.argv[3];
const shots = process.argv[4] ?? "/tmp/nc-onb";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
const visible = (step, timeout) => page.waitForSelector(`[data-step=${step}]:not(.hidden)`, { timeout });

await page.goto(`${base}/start`);
await shot("1-welcome");
await page.click("[data-go=sell]");
await page.fill("#store-name", `Nova Test ${Date.now().toString(36).slice(-4)}`);
await shot("2-sell");
await page.click("#create-store");
await visible("show", 120_000);
log("store created");
await page.fill("#biz-desc", "Relaxed everyday clothes made in Kyiv — denim, linen and knitwear. Delivery across Ukraine.");
await page.fill("#biz-link", "instagram.com/novawear");
if (photosDir) await page.setInputFiles("#photo-input", readdirSync(photosDir).filter((f) => f.endsWith(".jpg")).map((f) => join(photosDir, f)));
await shot("3-show");
await page.click("#analyze");
await visible("learn", 120_000);
log("analyzing");
await page.waitForTimeout(25_000);
await shot("4-learn");
await visible("opps", 600_000);
log("opportunities");
await shot("5-opps");
await page.click("#make-posts");
await visible("posts", 60_000);
await page.waitForSelector("#schedule-all:not([disabled])", { timeout: 900_000 });
log("posts ready");
await shot("6-posts");
await page.click("#schedule-all");
await visible("live", 120_000);
log("live");
await shot("7-live");
console.log("errors:", errors.length ? errors : "none");
await browser.close();
