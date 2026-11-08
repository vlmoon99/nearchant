// The widget page: one item (a tall card) or a store's items (a grid), as a complete HTML document for an <iframe>.
// The buttons open your item page in a new tab, where the buyer pays; nothing is paid inside the frame, so a host
// page can't make a buyer do anything unseen. Plain strings, no JSX or framework.
import { cssUrl, escapeHtml as e, safeUrl } from "./escape.js";
import { WIDGET_CSS } from "./widget-css.js";

export interface WidgetItem {
  id: string;
  title: string;
  /** Already formatted, e.g. "12 USDC". */
  price: string;
  /** Shows "From 12 USDC". */
  priceFrom?: boolean;
  img?: string;
  soldOut?: boolean;
  /** Short facts under the price: ["In stock", "Ships worldwide"]. */
  facts?: string[];
  /** "service" → the button says Book. */
  kind?: "product" | "service";
}

export interface WidgetStore { name: string; url: string }

export interface WidgetLabels { buy: string; book: string; soldOut: string; empty: string; trust: string; footer: (storeName: string) => string }
const LABELS: WidgetLabels = {
  buy: "Buy", book: "Book", soldOut: "Sold out", empty: "Nothing for sale right now.",
  trust: "🔒 Safe payment · escrow on NEAR", footer: (n) => `${n} ›`,
};

export interface RenderOptions {
  items: WidgetItem[];
  store: WidgetStore;
  /** Where the button goes (opens in a new tab). Add a ?ref=widget to count sales from widgets. */
  buyUrl: (item: WidgetItem) => string;
  /** "auto" follows the visitor's light/dark setting. Default "auto". */
  theme?: "auto" | "light" | "dark";
  /** Script inside the frame that reports its height to the host page (serve FRAME_JS there). null = none. */
  frameScriptSrc?: string | null;
  /** Link this stylesheet instead of inlining WIDGET_CSS (e.g. your own copy of widget.css). */
  cssHref?: string;
  labels?: Partial<WidgetLabels>;
  lang?: string;
}

/** The cards only (no <html>), for putting the widget straight into your own page instead of a frame. */
export function renderCards(o: Pick<RenderOptions, "items" | "store" | "buyUrl" | "labels">): string {
  const L = { ...LABELS, ...o.labels };
  const one = o.items.length === 1;
  const cards = o.items.map((i) => {
    const url = e(safeUrl(o.buyUrl(i)));
    const price = `${i.priceFrom ? "From " : ""}${i.price}`;
    const facts = i.soldOut ? L.soldOut : (i.facts ?? []).join(" · ");
    const button = i.soldOut
      ? `<span class="nw-btn secondary" aria-disabled="true">${e(L.soldOut)}</span>`
      : `<a class="nw-btn" href="${url}" target="_blank" rel="noopener">${e(i.kind === "service" ? L.book : L.buy)} · ${e(i.price)}</a>`;
    const img = i.img ? ` style="background-image:url('${e(cssUrl(i.img))}')"` : "";
    return `<article class="nw-card${i.soldOut ? " sold-out" : ""}">`
      + `<a class="nw-img" href="${url}" target="_blank" rel="noopener"${img} aria-label="${e(i.title)}"></a>`
      + `<div class="nw-body"><span class="nw-cap nw-muted nw-clamp1">${e(o.store.name)}</span>`
      + `<span class="nw-title nw-clamp2">${e(i.title)}</span><span class="nw-price">${e(price)}</span>`
      + (facts ? `<span class="nw-cap nw-muted nw-clamp1">${e(facts)}</span>` : "")
      + `${button}<span class="nw-cap nw-muted nw-trust">${e(L.trust)}</span></div></article>`;
  }).join("");
  const empty = o.items.length ? "" : `<p class="nw-muted nw-empty">${e(L.empty)}</p>`;
  return `<div class="${one ? "nw-one" : "nw-grid"}">${cards}${empty}</div>`
    + `<a class="nw-cap nw-muted nw-foot" href="${e(safeUrl(o.store.url))}" target="_blank" rel="noopener">${e(L.footer(o.store.name))}</a>`;
}

/** A whole HTML document for the widget frame. Serve it with widgetHeaders(). */
export function renderWidget(o: RenderOptions): string {
  const theme = o.theme ?? "auto";
  const title = o.items.length === 1 ? `${o.items[0]!.title} · ${o.store.name}` : o.store.name;
  const css = o.cssHref ? `<link rel="stylesheet" href="${e(o.cssHref)}">` : `<style>${WIDGET_CSS}</style>`;
  const frameSrc = o.frameScriptSrc === undefined ? "/embed-frame.js" : o.frameScriptSrc;
  const script = frameSrc ? `<script src="${e(frameSrc)}" defer></script>` : "";
  return `<!doctype html><html lang="${e(o.lang ?? "en")}"${theme === "auto" ? "" : ` data-theme="${theme}"`}><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)}</title>${css}${script}</head>`
    + `<body class="nw">${renderCards(o)}</body></html>`;
}

/** The page for an item that's gone (deleted, hidden). */
export function renderMissing(text = "This item isn't for sale any more."): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${WIDGET_CSS}</style></head><body class="nw"><p class="nw-muted nw-empty">${e(text)}</p></body></html>`;
}
