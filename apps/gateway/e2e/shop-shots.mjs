// Screenshots of the Shop, Orders and Settings pages and the buyer's item page (ADR 0026), light and dark,
// desktop and phone. Usage: node e2e/shop-shots.mjs <session token> <out dir> <handle> <item id> <order id>
import { chromium } from "playwright-core";
const [tok, out, handle, itemId, orderId] = process.argv.slice(2);
const base = process.env.BASE ?? "https://nearchant.com";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const pages = [["shop", "/app/shop"], ["shop-new", "/app/shop/new?kind=service"], ["shop-item", `/app/shop/${itemId}`], ["orders", "/app/orders?f=all"], ["order", `/app/orders/${orderId}`],
  ["settings", "/app/settings"], ["home", "/app"], ["store", `/h/${handle}/`], ["feed", "/feed"], ["buy", `/h/${handle}/i/${itemId}`], ["buyer-order", `/h/${handle}/o/${orderId}`]];
for (const [name, vp, scheme] of [["desk", { width: 1440, height: 900 }, "light"], ["deskdark", { width: 1440, height: 900 }, "dark"], ["mob", { width: 393, height: 852 }, "light"], ["mobdark", { width: 393, height: 852 }, "dark"]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: scheme });
  await ctx.addCookies([{ name: "nc_session", value: tok, domain: new URL(base).hostname, path: "/", secure: base.startsWith("https"), httpOnly: true }]);
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  for (const [n, path] of pages) {
    await page.goto(`${base}${path}`); await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${name}-${n}.png`, fullPage: true });
  }
  console.log(name, "errors:", errs.length ? errs : "none");
  await ctx.close();
}
await browser.close();
