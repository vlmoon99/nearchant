// The buy widget on someone else's website (ADR 0027): a plain page pastes the script tag; the widget must appear,
// size itself and open the item in a new tab. Also screenshots the seller's Share page.
//   node e2e/embed-check.mjs <seller session token> <shots dir> <handle> <item id>
import { createServer } from "node:http";
import { chromium } from "playwright-core";
const [tok, out, handle, itemId] = process.argv.slice(2);
const site = process.env.BASE ?? "https://nearchant.com";
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>My blog</title></head>
<body style="font-family:Georgia;max-width:720px;margin:40px auto;padding:0 16px"><h1>My luxury phones</h1><p>Order the one I wrote about:</p>
<script src="${site}/embed.js" data-nearchant-store="${handle}" data-nearchant-item="${itemId}" async></script>
<h2>Everything I sell</h2><script src="${site}/embed.js" data-nearchant-store="${handle}" async></script></body></html>`;
const srv = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end(html); }).listen(0);
const port = srv.address().port;
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 900, height: 900 } });
const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/`);
await p.waitForTimeout(4000);
const frames = await p.$$eval("iframe", (fs) => fs.map((f) => ({ src: f.src, h: f.style.height })));
console.log("widgets:", JSON.stringify(frames));
await p.screenshot({ path: `${out}/foreign-site.png`, fullPage: true });
const f = p.frames().find((x) => x.url().includes("/embed/i/"));
const [tab] = await Promise.all([ctx.waitForEvent("page"), f.click("a.btn")]);
await tab.waitForLoadState(); console.log("buy opens:", tab.url());
const s = await b.newContext({ viewport: { width: 1280, height: 900 } });
await s.addCookies([{ name: "nc_session", value: tok, domain: new URL(site).hostname, path: "/", secure: true, httpOnly: true }]);
const sp = await s.newPage(); sp.on("pageerror", (e) => errs.push(e.message));
await sp.goto(`${site}/app/shop/${itemId}/share`); await sp.waitForTimeout(3000); await sp.screenshot({ path: `${out}/share-item.png`, fullPage: true });
await sp.goto(`${site}/app/shop/share`); await sp.waitForTimeout(3000); await sp.screenshot({ path: `${out}/share-shop.png`, fullPage: true });
console.log("errors:", errs.length ? errs : "none");
await b.close(); srv.close();
