// Design review: every page and the main interactive states, light + dark, phone + desktop, combined into one
// contact sheet per screen (phone light | phone dark | desktop light | desktop dark).
//   node e2e/all-shots.mjs <seller session token> <out dir> <handle> <product id> <service id> <order id> <done order id> <post id>
import { chromium } from "playwright-core";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
const [tok, out, handle, item, service, order, doneOrder, post] = process.argv.slice(2);
const base = process.env.BASE ?? "https://nearchant.com";
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
mkdirSync(`${out}/raw`, { recursive: true });
const seller = true, buyer = false;
// [name, path, signed in as seller?, action on the page before the shot]
const screens = [
  ["landing", "/", buyer], ["start", "/start", buyer], ["verify", "/verify", buyer],
  ["feed", "/feed", buyer], ["feed-orders", "/feed/orders", buyer], ["feed-following", "/feed/following", buyer],
  ["feed-signin-sheet", "/feed", buyer, async (p) => { await p.click("[data-buyer-me]:visible"); }],
  ["store", `/h/${handle}/`, buyer], ["store-posts", `/h/${handle}/posts`, buyer], ["post", `/h/${handle}/p/${post}`, buyer],
  ["item", `/h/${handle}/i/${item}`, buyer], ["item-invalid", `/h/${handle}/i/${item}`, buyer, async (p) => { await p.click("form.order button[type=submit]"); }],
  ["service", `/h/${handle}/i/${service}`, buyer], ["buyer-order", `/h/${handle}/o/${order}`, buyer], ["buyer-order-done", `/h/${handle}/o/${doneOrder}`, buyer],
  ["embed-item", `/h/${handle}/embed/i/${item}`, buyer], ["embed-shop", `/h/${handle}/embed`, buyer],
  ["app-home", "/app", seller], ["app-posts", "/app/posts", seller], ["app-post", `/app/posts/${post}`, seller], ["app-create", "/app/create", seller],
  ["app-shop", "/app/shop", seller], ["app-shop-new", "/app/shop/new", seller], ["app-shop-new-service", "/app/shop/new?kind=service", seller],
  ["app-item", `/app/shop/${item}`, seller], ["app-item-share", `/app/shop/${item}/share`, seller], ["app-shop-share", "/app/shop/share", seller],
  ["app-orders", "/app/orders?f=all", seller], ["app-order", `/app/orders/${order}`, seller],
  ["app-order-confirm", `/app/orders/${order}`, seller, async (p) => { await p.click("[data-order-refund]:visible"); }],
  ["app-order-done", `/app/orders/${doneOrder}`, seller],
  ["app-wallet", "/app/wallet", seller], ["app-analytics", "/app/analytics", seller], ["app-settings", "/app/settings", seller],
].filter((s) => !only || only.test(s[0]));
const variants = [["mob", { width: 393, height: 852 }, "light", true], ["mobdark", { width: 393, height: 852 }, "dark", true], ["desk", { width: 1440, height: 900 }, "light", false], ["deskdark", { width: 1440, height: 900 }, "dark", false]];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = {};
for (const [v, vp, scheme, mobile] of variants) {
  for (const asSeller of [true, false]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, colorScheme: scheme, isMobile: mobile, hasTouch: mobile });
    if (asSeller) await ctx.addCookies([{ name: "nc_session", value: tok, domain: new URL(base).hostname, path: "/", secure: true, httpOnly: true }]);
    const page = await ctx.newPage();
    for (const [name, path, s, act] of screens.filter((x) => x[2] === asSeller)) {
      const errs = []; const on = (e) => errs.push(e.message); page.on("pageerror", on);
      await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1500);
      if (act) { try { await act(page); await page.waitForTimeout(900); } catch (e) { errs.push(`action: ${e.message.slice(0, 80)}`); } }
      // Wider than the screen = the page scrolls sideways: name the elements that stick out.
      const wide = await page.evaluate((W) => { if (document.documentElement.scrollWidth <= W + 1) return null;
        return [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.right > W + 1 && r.width > 0 && getComputedStyle(e).position !== "fixed"; })
          .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} (${Math.round(e.getBoundingClientRect().right)}px)`); }, vp.width).catch(() => null);
      if (wide) errs.push(`scrolls sideways: ${wide.join(", ")}`);
      await page.screenshot({ path: `${out}/raw/${name}-${v}.png`, fullPage: !act }).catch((e) => errs.push(e.message));
      page.off("pageerror", on);
      if (errs.length) (errors[name] ??= []).push(`${v}: ${errs.join(" | ")}`);
    }
    await ctx.close();
  }
}
await browser.close();
// Contact sheets: phones at full size, desktops at half; tall pages cut at 2600 px (phone) / 1800 px (desktop, half).
for (const [name] of screens) {
  const tiles = [];
  for (const [v, , , mobile] of variants) {
    try {
      let img = sharp(`${out}/raw/${name}-${v}.png`);
      const m = await img.metadata();
      if (!mobile) img = img.resize({ width: Math.round(m.width / 2) });
      const buf = await img.png().toBuffer(); const mm = await sharp(buf).metadata();
      const h = Math.min(mm.height, mobile ? 2600 : 1800);
      tiles.push({ buf: await sharp(buf).extract({ left: 0, top: 0, width: mm.width, height: h }).toBuffer(), w: mm.width, h });
    } catch { /* missing */ }
  }
  if (!tiles.length) continue;
  const W = tiles.reduce((a, t) => a + t.w + 16, 16), H = Math.max(...tiles.map((t) => t.h)) + 32;
  let x = 16; const comp = tiles.map((t) => { const c = { input: t.buf, left: x, top: 16 }; x += t.w + 16; return c; });
  await sharp({ create: { width: W, height: H, channels: 3, background: "#ff00ff" } }).composite(comp).png().toFile(`${out}/${name}.png`);
}
console.log(JSON.stringify({ screens: screens.length, errors }, null, 1));
