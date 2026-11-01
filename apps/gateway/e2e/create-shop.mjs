// Creates a shop through /new in a real browser (installed Chrome) and opens its card.
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:8787";
const handle = process.argv[3] ?? `e2e${Date.now().toString(36)}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${base}/new`);
await page.fill("input[name=handle]", handle);
await page.waitForFunction(() => document.querySelector("#handle-hint")?.textContent?.includes("free"), null, { timeout: 15_000 });
await page.fill("input[name=name]", "E2E Decks");
await page.fill("textarea[name=bio]", "A test shop created by the end-to-end script.");
await page.click("#new-shop button");
await page.waitForSelector("#new-shop output a[href$='/']", { timeout: 120_000 });
console.log("result:", await page.locator("#new-shop output").textContent());
await page.click("text=open your shop");
await page.waitForSelector("h1");
console.log("card:", await page.locator("h1").first().textContent(), "|", await page.locator("p.account").textContent(), "|", await page.locator(".price").first().textContent());
await browser.close();
