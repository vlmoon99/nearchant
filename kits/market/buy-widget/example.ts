// A demo store widget + a demo host page on plain node:http.   npx tsx example.ts   (PORT=8788 by default)
// Open http://localhost:8788/ : the host page loads the widget from http://127.0.0.1:8788, a different origin,
// so you see the cross-site case (frame + auto height) on one machine.
import { createServer } from "node:http";
import { FRAME_JS, LOADER_JS, frameScriptHeaders, loaderHeaders, renderMissing, renderWidget, snippets, widgetHeaders, type WidgetItem } from "./src/index.js";

const port = Number(process.env.PORT ?? 8788);
const widgetOrigin = `http://127.0.0.1:${port}`;
const store = { name: "Ann's Bakery", url: `${widgetOrigin}/store/ann` };
const items: WidgetItem[] = [
  { id: "cake", title: "Lemon cake", price: "12 USDC", facts: ["In stock", "Pickup only"], img: "https://images.unsplash.com/photo-1519915028121-7d3463d20b13?w=600" },
  { id: "class", title: "Baking class (2 h)", price: "30 USDC", priceFrom: true, kind: "service", facts: ["In person", "Ready in 7 days"] },
  { id: "bread", title: "Sourdough loaf", price: "6 USDC", soldOut: true },
];
const buyUrl = (i: WidgetItem) => `${store.url}/i/${i.id}?ref=widget`;
const loader = LOADER_JS(); // origin = wherever embed.js was loaded from

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const send = (status: number, headers: Record<string, string>, body: string) => { res.writeHead(status, headers); res.end(body); };
  if (path === "/embed.js") return send(200, loaderHeaders(), loader);
  if (path === "/embed-frame.js") return send(200, frameScriptHeaders(), FRAME_JS);
  if (path === "/embed/ann") return send(200, widgetHeaders(), renderWidget({ items, store, buyUrl }));
  const one = /^\/embed\/ann\/i\/([^/]+)$/.exec(path);
  if (one) {
    const item = items.find((i) => i.id === decodeURIComponent(one[1]!));
    return send(item ? 200 : 404, widgetHeaders(), item ? renderWidget({ items: [item], store, buyUrl }) : renderMissing());
  }
  if (path.startsWith("/store/ann")) return send(200, { "content-type": "text/plain; charset=utf-8" }, `Your checkout page would be here: ${path}`);
  if (path === "/") {
    const a = snippets({ base: widgetOrigin, store: "ann", item: "cake" }), b = snippets({ base: widgetOrigin, store: "ann" });
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return send(200, { "content-type": "text/html; charset=utf-8" }, `<!doctype html><meta charset="utf-8"><title>Host page</title>
<body style="font-family:system-ui;max-width:900px;margin:32px auto;padding:0 16px">
<h1>Someone's website</h1><p>One item, via the script snippet:</p><pre>${esc(a.script)}</pre>${a.script}
<p>The whole store, via an iframe:</p><pre>${esc(b.iframe)}</pre>${b.iframe}</body>`);
  }
  send(404, { "content-type": "text/plain" }, "not found");
});
server.listen(port, () => console.log(`host page: http://localhost:${port}/   widget: ${widgetOrigin}/embed/ann`));
