// Screenshots of seller pages with a session cookie: node e2e/pages-shots.mjs <token> <outDir> [paths...]
import { chromium } from "playwright-core";
const [tok, out, ...paths] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, vp] of [["desk", { width: 1440, height: 900 }], ["mob", { width: 393, height: 852 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.addCookies([{ name: "nc_session", value: tok, domain: "nearchant.com", path: "/", secure: true, httpOnly: true }]);
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  for (const p of paths) { await page.goto(`https://nearchant.com${p}`); await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${name}${p.replaceAll("/", "-")}.png`, fullPage: name === "desk" }); }
  console.log(name, "errors:", errs.length ? errs : "none"); await ctx.close();
}
await browser.close();
