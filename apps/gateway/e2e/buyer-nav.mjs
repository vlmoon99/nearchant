// Buyer navigation audit: crawls every buyer page reachable from the feed and a store (on nearchant.com/h/… and on
// the store's own subdomain), at phone size, and reports broken links, dead ends, links into the seller app, hidden
// navigation, and pages without a way back. node e2e/buyer-nav.mjs <handle> [maxPages]
import { chromium } from "playwright-core";
const [handle, max = "80"] = process.argv.slice(2);
const site = process.env.BASE ?? "https://nearchant.com";
const sub = `https://${handle}.${new URL(site).hostname}`;
const starts = [`${site}/feed`, `${site}/h/${handle}/`, `${sub}/`];
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const seen = new Set(), queue = [...starts], report = [];
const norm = (u) => { const x = new URL(u); x.hash = ""; x.searchParams.delete("ref"); return x.toString(); };
const allowed = (u) => { try { const h = new URL(u).hostname; return h === new URL(site).hostname || h === new URL(sub).hostname; } catch { return false; } };
while (queue.length && seen.size < Number(max)) {
  const url = queue.shift(); const key = norm(url);
  if (seen.has(key)) continue; seen.add(key);
  const errs = []; const onErr = (e) => errs.push(e.message); page.on("pageerror", onErr);
  const res = await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => ({ status: () => `ERR ${e.message.slice(0, 60)}` }));
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const links = [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: (a.textContent || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40), visible: vis(a) }));
    return { title: document.title, h1: document.querySelector("h1")?.textContent?.trim().slice(0, 60) ?? "", links };
  });
  page.off("pageerror", onErr);
  const visible = info.links.filter((l) => l.visible);
  const issues = [];
  if (typeof res?.status === "function" && String(res.status()) !== "200") issues.push(`status ${res.status()}`);
  if (errs.length) issues.push(`JS errors: ${errs.join(" | ").slice(0, 120)}`);
  const app = visible.filter((l) => /\/app(\/|$)/.test(new URL(l.href).pathname)); if (app.length) issues.push(`links into the SELLER app: ${app.map((l) => `"${l.text}"→${new URL(l.href).pathname}`).join(", ")}`);
  const hidden = info.links.filter((l) => !l.visible && l.text && !/^#/.test(new URL(l.href).hash) && allowed(l.href)).map((l) => l.text);
  if (hidden.length) issues.push(`hidden links: ${[...new Set(hidden)].slice(0, 6).join(", ")}`);
  const toFeed = visible.some((l) => /\/feed(\?|$)/.test(new URL(l.href).pathname + new URL(l.href).search) || new URL(l.href).pathname === "/feed");
  const toOrders = visible.some((l) => /\/feed\/orders/.test(l.href));
  if (!toFeed) issues.push("no visible link to the shop feed");
  if (!toOrders) issues.push("no visible link to My orders");
  report.push({ url: key.replace(site, "").replace(sub, "[sub]"), title: info.title, h1: info.h1, issues });
  for (const l of info.links) if (allowed(l.href) && !/\.(png|jpg|webp|js|css)(\?|$)/.test(l.href) && !/\/banner\//.test(l.href) && !l.href.includes("download")) queue.push(l.href);
}
// link targets that fail
const broken = [];
for (const r of report) if (r.issues.some((i) => i.startsWith("status"))) broken.push(r.url);
console.log(JSON.stringify({ pages: report.length, broken, report }, null, 1));
await b.close();
