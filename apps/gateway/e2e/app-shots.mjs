import { chromium } from "playwright-core";
const [tok, out] = [process.argv[2], process.argv[3]];
const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const [name, vp] of [["desk", { width: 1440, height: 900 }], ["mob", { width: 393, height: 852 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "nc_session", value: tok, domain: "nearchant.com", path: "/", secure: true, httpOnly: true }]);
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("https://nearchant.com/app/posts?f=all"); 
  const first = await page.$eval("a.post", (a) => a.getAttribute("href")).catch(() => null);
  for (const [n, path] of [["home", "/app"], ["create", "/app/create"], ["posts", "/app/posts"], ["post", first ?? "/app/posts"]]) {
    await page.goto(`https://nearchant.com${path}`); await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${name}-${n}.png`, fullPage: name === "mob" ? false : true });
  }
  console.log(name, "errors:", errs.length ? errs : "none", "first post:", first);
  await ctx.close();
}
await browser.close();
