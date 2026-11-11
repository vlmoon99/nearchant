// Shopping ↔ selling on a live site: a signed-in buyer taps "Become a seller", opens a store with the same email,
// then switches between the seller app and the shop feed (phone and desktop).
//   BUYER_COOKIE=nc_buyer=… node e2e/roles.mjs [baseUrl] [shotsDir]
// The buyer cookie comes from the caller (a test buyer row + a session signed with the server's buyer key).
import { chromium } from "playwright-core";
const [base = "https://nearchant.com", shots = "/tmp/nc-roles"] = process.argv.slice(2);
const cookie = process.env.BUYER_COOKIE ?? "";
const email = process.env.BUYER_EMAIL ?? "";
if (!cookie.startsWith("nc_buyer=")) throw new Error("set BUYER_COOKIE=nc_buyer=…");
const host = new URL(base).hostname;
const b = await chromium.launch({ channel: "chrome", headless: true });
const fail = (m) => { console.error(`FAIL ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`ok   ${m}`);
const text = async (page, sel) => (await page.locator(sel).first().textContent({ timeout: 8000 }).catch(() => ""))?.trim().replace(/\s+/g, " ") ?? "";

// 1. Signed out, phone: the feed offers selling; /sell → onboarding; onboarding offers the feed back.
{
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${base}/feed`);
  const label = await text(page, ".sell-link.only-m [data-sell-label]");
  label === "Sell on Nearchant" ? ok(`signed out: feed button "${label}"`) : fail(`signed out: feed button "${label}"`);
  await page.locator(".sell-link.only-m").click(); await page.waitForURL(/\/start$/);
  ok("signed out: Sell → /start");
  (await page.locator('a[href="/feed"]', { hasText: "Just shopping" }).count()) ? ok("onboarding links back to the feed") : fail("no feed link on onboarding");
  await page.screenshot({ path: `${shots}/1-signed-out-start.png` });
  errs.length ? fail(`JS errors: ${errs.join(" | ")}`) : ok("no JS errors");
  await ctx.close();
}

// 2. Signed-in buyer, phone: account sheet → Become a seller → onboarding with the email filled → store created.
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const [name, value] = [cookie.slice(0, cookie.indexOf("=")), cookie.slice(cookie.indexOf("=") + 1)];
await ctx.addCookies([{ name, value, domain: host, path: "/", httpOnly: true, secure: base.startsWith("https"), sameSite: "Lax" }]);
const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${base}/feed`);
await page.waitForFunction(() => document.querySelector(".buyertabs [data-buyer-label]")?.textContent === "You", null, { timeout: 10000 }).then(() => ok("buyer tab says You"), () => fail("buyer tab not signed in"));
await page.locator(".buyertabs [data-buyer-me]").click();
await page.waitForSelector(".sheet [data-become-seller]", { timeout: 8000 }).then(() => ok("account sheet: Become a seller"), () => fail("no Become a seller in the account sheet"));
await page.waitForTimeout(700); await page.screenshot({ path: `${shots}/2-account-sheet-buyer.png` });
await page.locator(".sheet [data-become-seller]").click(); await page.waitForURL(/\/start$/);
await page.locator("[data-step=welcome] [data-go=sell]").click();
await page.waitForSelector("#buyer-note:not(.hidden)", { timeout: 8000 }).then(() => ok("onboarding: signed-in buyer note shown"), () => fail("no buyer note on onboarding"));
const filled = await page.inputValue("#contact-email");
filled === email ? ok(`contact email pre-filled (${filled})`) : fail(`contact email "${filled}", want "${email}"`);
const storeName = `Roles Test ${Date.now().toString(36).slice(-4)}`;
await page.fill("#store-name", storeName);
await page.locator("[data-kind=services]").click();
await page.screenshot({ path: `${shots}/3-onboarding-sell.png` });
await page.locator("#create-store").click();
await page.waitForSelector("[data-step=show]:not(.hidden)", { timeout: 90000 }).then(() => ok(`store "${storeName}" created`), async () => fail(`store not created: ${await text(page, "#sell-out")}`));
const me = await page.evaluate(() => fetch("/api/me").then((r) => r.json()));
me.store && me.buyer ? ok(`/api/me: buyer + store ${me.store.handle}`) : fail(`/api/me ${JSON.stringify(me)}`);
console.log(`STORE ${me.store?.handle ?? ""}`);

// 3. Seller app, phone: the shop button in the top bar and "Switch to shopping" in Settings.
await page.goto(`${base}/app`);
(await page.locator('.topbar a[aria-label="Switch to shopping"]').isVisible()) ? ok("phone top bar: shop button") : fail("no shop button in the phone top bar");
await page.screenshot({ path: `${shots}/4-app-home-phone.png` });
await page.goto(`${base}/app/settings`);
(await page.locator('.list.only-m a[href="/feed"]', { hasText: "Switch to shopping" }).isVisible()) ? ok("phone Settings: Switch to shopping") : fail("no Switch to shopping in Settings");
await page.locator('.topbar a[aria-label="Switch to shopping"]').click(); await page.waitForURL(/\/feed$/);

// 4. Back on the feed: "Your store", and the sheet says Switch to selling → /app.
await page.waitForFunction(() => document.querySelector(".sell-link.only-m [data-sell-label]")?.textContent === "Your store", null, { timeout: 10000 }).then(() => ok("feed button: Your store"), () => fail("feed button not relabelled"));
await page.locator(".buyertabs [data-buyer-me]").click();
const sw = await text(page, ".sheet [data-switch-sell]");
sw.includes("Switch to selling") && sw.includes(storeName) ? ok(`account sheet: "${sw}"`) : fail(`account sheet: "${sw}"`);
await page.waitForTimeout(700); await page.screenshot({ path: `${shots}/5-account-sheet-seller.png` });
await page.locator(".sheet [data-switch-sell]").click(); await page.waitForURL(/\/app$/);
ok("Switch to selling → /app");
errs.length ? fail(`JS errors: ${errs.join(" | ")}`) : ok("no JS errors (phone)");

// 5. Desktop: the sidebar switch and the header button.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${base}/app`);
const seg = await page.locator(".side .role-switch a").allTextContents();
seg.join("|") === "Selling|Shopping" ? ok("sidebar: Selling | Shopping") : fail(`sidebar switch ${seg}`);
await page.screenshot({ path: `${shots}/6-app-desktop.png` });
await page.locator(".side .role-switch a", { hasText: "Shopping" }).click(); await page.waitForURL(/\/feed$/);
await page.waitForFunction(() => document.querySelector(".buyerlinks [data-sell-label]")?.textContent === "Your store", null, { timeout: 10000 }).then(() => ok("desktop header: Your store"), () => fail("desktop header not relabelled"));
await page.screenshot({ path: `${shots}/7-feed-desktop.png` });
await page.locator(".buyerlinks [data-sell-link]").click(); await page.waitForURL(/\/app$/);
ok("desktop: Your store → /app");
await b.close();
