// Shop: add a service in the app and watch the item page follow the safety check by itself (Checking… → Live).
//   node e2e/item-live.mjs <seller session token> <shots dir>
import { chromium } from "playwright-core";
const [tok, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
await ctx.addCookies([{ name: "nc_session", value: tok, domain: "nearchant.com", path: "/", secure: true, httpOnly: true }]);
const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
await p.goto("https://nearchant.com/app/shop/new?kind=service");
await p.fill("input[name=title]", "Denim repair and tapering");
await p.fill("input[name=price]", "2");
await p.fill("textarea[name=description]", "We fix rips, replace zips and taper jeans. Send them by post or drop them at the studio.");
await p.fill("input[name=question]", "What should we fix?");
await p.click("#item-form button[type=submit]");
await p.waitForURL(/\/app\/shop\/i-/, { timeout: 20_000 });
await p.waitForSelector("[data-live-item]", { timeout: 10_000 }).then(async () => log(`item page: "${await p.textContent("[data-live-item] [data-live-text]")}"`)).catch(() => log("no checking banner (already checked)"));
await p.screenshot({ path: `${out}/item-checking.png` });
await p.waitForFunction(() => !document.querySelector("[data-live-item]"), null, { timeout: 150_000 });
log(`after check: kicker "${await p.textContent(".kicker")}"`);
await p.screenshot({ path: `${out}/item-checked.png` });
console.log("errors:", errs.length ? errs : "none"); await b.close();
