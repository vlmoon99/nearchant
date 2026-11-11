// Onboarding end to end in Chrome at phone size: /start → store → photos → analysis → opportunities → posts → live.
//   node e2e/onboard.mjs [baseUrl] [photosDir] [shotsDir]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";

const base = process.argv[2] ?? "https://nearchant.com";
const photosDir = process.argv[3];
const shots = process.argv[4] ?? "/tmp/nc-onb";
// ENGINE=webkit (Safari's engine) and VIEWPORT=1440x900 for the desktop card layout; default Chrome at phone size.
const [vw, vh] = (process.env.VIEWPORT ?? "393x852").split("x").map(Number);
const browser = process.env.ENGINE === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log("PAGE ERROR:", e.message); });
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text()); });
const t0 = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const shot = (n) => page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
const visible = (step, timeout) => page.waitForSelector(`[data-step=${step}]:not(.hidden)`, { timeout });

await page.goto(`${base}/start`);
await shot("1-welcome");
await page.click("[data-go=sell]");
await page.fill("#store-name", `Nova Test ${Date.now().toString(36).slice(-4)}`);
await page.fill("#contact-email", "e2e-journey@example.invalid"); // buyers reach the store here (required since ADR 0026)
await shot("2-sell");
await page.click("#create-store");
await visible("show", 120_000);
log("store created");
await page.fill("#biz-desc", "Relaxed everyday clothes designed in SoHo, New York — denim, linen and knitwear. We ship across the US.");
await page.fill("#biz-link", "instagram.com/novawear.nyc");
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
for (let i = 0; i < 20 && process.env.DEBUG_POSTS; i++) {
  console.log("posts step:", JSON.stringify(await page.evaluate(() => { const b = document.querySelector("#schedule-all"); const r = b.getBoundingClientRect(); return { disabled: b.disabled, display: getComputedStyle(b).display, vis: getComputedStyle(b).visibility, h: Math.round(r.height), y: Math.round(r.y), title: document.querySelector("#posts-title")?.textContent, cards: document.querySelectorAll("#first-posts .card").length }; })));
  await page.waitForTimeout(30_000);
}
await page.waitForSelector("#schedule-all:not([disabled])", { timeout: 900_000 });
log("posts ready");
console.log("thumb check:", await page.evaluate(async () => {
  const r = await fetch("/api/app/posts").then((x) => x.json());
  const u = r.posts.find((p) => p.imageUrl)?.imageUrl;
  if (!u) return "no imageUrl in API";
  const f = await fetch(u);
  return `${u} → ${f.status} ${f.headers.get("content-type")}`;
}));
await page.waitForTimeout(3000); // let the thumbnails load
await shot("6-posts");
await page.click("#schedule-all");
await visible("live", 120_000);
log("live");
await shot("7-live");
console.log("errors:", errors.length ? errors : "none");
// For e2e/journey.sh: list the first photo as an item for sale, then hand over the store and its session.
if (process.env.LIST_ITEM) {
  const handle = await page.evaluate(async () => {
    const me = await fetch("/api/app/me").then((r) => r.json());
    const photo = (await fetch("/api/app/photos").then((r) => r.json())).photos[0];
    const r = await fetch("/api/app/items", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dark denim jacket", price: 1, description: "Designed in New York.", options: ["S", "M", "L"], photoMediaId: photo?.id }) });
    if (!r.ok) throw new Error(`item: ${r.status}`);
    return me.handle;
  });
  const token = (await page.context().cookies()).find((c) => c.name === "nc_session").value;
  console.log(`STORE ${base}/h/${handle}/ ${token}`);
}
await browser.close();
