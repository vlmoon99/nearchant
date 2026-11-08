# Buy widget

An embeddable "Buy" card, or a grid of a store's items, that other websites put on their pages with one script tag or an iframe. Your server renders it as plain HTML strings, with no framework and no dependencies.

## Copy it

```sh
cp -r kits/market/buy-widget  your-app/src/buy-widget      # no npm install needed
```

```ts
import { renderWidget, widgetHeaders, LOADER_JS, FRAME_JS, loaderHeaders, frameScriptHeaders } from "./buy-widget/src/index.js";
```

## Use it

Your server serves three things:

- `/embed.js`: the loader that site owners include
- `/embed-frame.js`: runs inside the frame and reports its height
- `/embed/<store>` and `/embed/<store>/i/<item>`: the widget pages

**Hono**

```ts
const loader = LOADER_JS();
app.get("/embed.js", (c) => c.body(loader, 200, loaderHeaders()));
app.get("/embed-frame.js", (c) => c.body(FRAME_JS, 200, frameScriptHeaders()));
app.get("/embed/:store/i/:item", async (c) => {
  const { store, item } = await loadItem(c.req.param("store"), c.req.param("item"));   // your data
  return c.body(renderWidget({ items: [item], store, buyUrl: (i) => `${store.url}/i/${i.id}?ref=widget` }), 200, widgetHeaders());
});
```

If you use `secureHeaders()` on every route, skip it for widget paths (`isWidgetPath(c.req.path)`). Its `frame-ancestors`/`X-Frame-Options` would stop other sites from framing the widget.

**Express**

```ts
app.get("/embed.js", (_req, res) => res.set(loaderHeaders()).send(loader));
app.get("/embed-frame.js", (_req, res) => res.set(frameScriptHeaders()).send(FRAME_JS));
app.get("/embed/:store", async (req, res) => {
  const { store, items } = await loadStore(req.params.store);
  res.set(widgetHeaders()).send(renderWidget({ items, store, buyUrl: (i) => `${store.url}/i/${i.id}` }));
});
```

If you use helmet, turn off `frameguard` and `frame-ancestors` for these routes.

**node:http**

```ts
createServer((req, res) => {
  if (req.url === "/embed.js") { res.writeHead(200, loaderHeaders()); return res.end(loader); }
  if (req.url === "/embed-frame.js") { res.writeHead(200, frameScriptHeaders()); return res.end(FRAME_JS); }
  // …match /embed/<store> → res.writeHead(200, widgetHeaders()); res.end(renderWidget({...}))
});
```

`example.ts` is a complete node:http server (`npx tsx example.ts`). It serves a demo store widget and a host page at <http://localhost:8788/>, which loads the widget from `127.0.0.1`, a different origin.

**What site owners paste.** `snippets({ base, store, item })` generates both forms for your "Share" page:

```html
<!-- auto height; the frame goes right after the tag -->
<script src="https://your.site/embed.js" data-nearkit-store="ann" data-nearkit-item="cake" async></script>

<!-- or a plain iframe (fixed height) -->
<iframe src="https://your.site/embed/ann/i/cake" title="Buy" loading="lazy" style="width:100%;max-width:420px;height:640px;border:0"></iframe>
```

## Options

`renderWidget(options)`

| Option | Default | Meaning |
|---|---|---|
| `items` | — | `{ id, title, price, priceFrom?, img?, soldOut?, facts?, kind? }`. One item renders a card, several render a grid, none renders "Nothing for sale" |
| `store` | — | `{ name, url }`. The footer links to `url` |
| `buyUrl(item)` | — | Where the button goes, in a new tab. Only `http(s)` URLs and paths are allowed |
| `theme` | `auto` | `auto` follows the visitor; `light` or `dark` fixes it |
| `frameScriptSrc` | `/embed-frame.js` | `null` means no height reporting |
| `cssHref` | inline `WIDGET_CSS` | Link your own copy of `widget.css` instead |
| `labels` | English | `{ buy, book, soldOut, empty, trust, footer(name) }` |
| `lang` | `en` | |

`LOADER_JS(origin?, pathFor?, { attr, title, heights })`:

- `origin` defaults to the origin `embed.js` was loaded from.
- `pathFor` defaults to `{ store: "/embed/{store}", item: "/embed/{store}/i/{item}" }`.
- `attr` defaults to `nearkit`, which gives the `data-nearkit-store` / `data-nearkit-item` attributes and the postMessage key. Use the same attr in `frameJs(attr)`.

Other exports:

- `widgetHeaders({ imgSrc, scriptSrc })`, `loaderHeaders()`, `frameScriptHeaders()` and `isWidgetPath(path, prefix)`
- `renderCards()`, the cards without `<html>`, for your own pages
- `renderMissing()`
- `escapeHtml`, `safeUrl` and `cssUrl`

To theme the widget, override the `--nw-*` variables in `widget.css`.

## How it works

```
host page ── <script src=…/embed.js data-nearkit-store=ann data-nearkit-item=cake>
               └─ loader: finds its tags → inserts <iframe src=origin+/embed/ann/i/cake> after each
                     frame page (renderWidget) ── FRAME_JS: postMessage({nearkit:"height", h})
               └─ loader resizes the iframe — only for messages from that frame's window AND your origin
Buy button ── opens your item page in a new tab (target=_blank rel=noopener); payment happens there
```

**Framing.** The widget page is meant to be framed by any site, so `widgetHeaders()` sends no `frame-ancestors` and no `X-Frame-Options`. Nearchant first used `frame-ancestors *`, but browsers still refused `file://` pages, so a store owner testing the snippet in a local `index.html` saw "refused to connect". Removing the directive fixed that. It is safe for two reasons: the frame holds no session or cookie, and its only action opens your site in a new tab. Clickjacking has nothing to click.

**Escaping.** Item titles, store names and image URLs come from sellers. Everything is HTML-escaped, and URLs are limited to `http(s)` and paths. Image URLs are also percent-encoded inside `url('…')`, so they can't break out of the style attribute.

**Colour scheme.** The frame follows the visitor's light or dark setting. On a light site in dark mode, the browser paints the frame as an opaque dark box. That keeps text readable, where a transparent frame would put light text on a light page. If you fix `theme`, the frame no longer follows the visitor.

## Tested

There are 18 tests:

- Rendering one item, a grid, and the empty state
- HTML/attribute/CSS-url escaping with hostile titles, URLs and image URLs
- The sold-out state (no buy link, `aria-disabled`)
- Book and From labels, theme, labels, `cssHref`, and no frame script
- `widget.css` staying identical to the inlined CSS
- Headers: no `frame-ancestors`, no `X-Frame-Options`, extra CSP origins, and CORS on the loader
- The loader run in a happy-dom page: iframe URLs from the data attributes (encoded), placement after the tag, no duplicates, custom origin/paths/attr, and resizing only for the right origin and source with a numeric height
- The frame script posting its height
- Snippets

**Checked by hand, not in CI:**

- The example in headless Chrome: the cross-origin frame auto-sized from 520 to 636 px, and the grid showed Buy, Book and Sold out in light and dark.

**Not tested:**

- Old browsers without `ResizeObserver` (the frame keeps its starting height there)
- Express and Hono wiring, beyond the snippets above

## Came from

Nearchant's buy widget (ADR 0027):

- `apps/gateway/src/ui/embed.tsx`: `EmbedPage`, `EMBED_LOADER_JS`, `EMBED_FRAME_JS`
- `embedHeaders` and `isEmbed` in `apps/gateway/src/app.tsx`
- the `.embed-*` styles in `apps/gateway/web/ui.css`
