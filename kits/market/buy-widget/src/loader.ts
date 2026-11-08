// The two scripts of the widget:
// Colour scheme: the frame follows the visitor's light/dark setting. When that differs from the host page's scheme,
// browsers paint the frame opaque (in dark mode on a light site: a dark card on its own dark box). We keep that:
// a transparent frame would leave the frame's light text on the host's light background.
//   LOADER_JS → served as /embed.js; a site owner pastes <script src="https://you/embed.js" data-…-store="…" async>
//               and it puts an <iframe> right after that script tag, then keeps its height in step with the content.
//   FRAME_JS  → runs inside the frame (renderWidget links it) and posts its height to the parent page.
import { jsLiteral } from "./escape.js";

export interface PathTemplates {
  /** Path of a whole-store widget. {store} is replaced (URL-encoded). Default "/embed/{store}". */
  store: string;
  /** Path of a one-item widget. {store} and {item}. Default "/embed/{store}/i/{item}". */
  item: string;
}

export interface LoaderOptions {
  /** data-<attr>-store / data-<attr>-item on the script tag, and the postMessage key. Default "nearkit". */
  attr?: string;
  /** iframe title (screen readers). */
  title?: string;
  /** Starting heights before the frame reports its own. */
  heights?: { item: number; store: number };
}

const DEFAULT_PATHS: PathTemplates = { store: "/embed/{store}", item: "/embed/{store}/i/{item}" };
const camel = (a: string) => a.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
const checkAttr = (a: string) => { if (!/^[a-z][a-z0-9-]*$/.test(a)) throw new Error("attr must be lowercase letters, digits and dashes"); return a; };

/**
 * The loader script. `origin` = where your widget pages live (default: the origin the script itself was loaded
 * from, so one file works on any host). `pathFor` = how to turn the tag's store/item into a path.
 */
export function LOADER_JS(origin?: string | null, pathFor: Partial<PathTemplates> = {}, o: LoaderOptions = {}): string {
  const attr = checkAttr(o.attr ?? "nearkit"), key = camel(attr);
  const paths = { ...DEFAULT_PATHS, ...pathFor };
  const h = o.heights ?? { item: 520, store: 640 };
  const cfg = { origin: origin ?? null, paths, key, sel: `script[data-${attr}-store]`, title: o.title ?? "Buy", h };
  return `(()=>{const C=${jsLiteral(cfg)};const me=document.currentScript;const origin=C.origin||new URL(me.src).origin;
const enc=encodeURIComponent,K=C.key,cap=K+"Store",itm=K+"Item",done=K+"Done";
document.querySelectorAll(C.sel).forEach((s)=>{if(s.dataset[done])return;s.dataset[done]="1";
const store=s.dataset[cap],item=s.dataset[itm];if(!store)return;
const path=(item?C.paths.item:C.paths.store).replace("{store}",enc(store)).replace("{item}",item?enc(item):"");
const f=document.createElement("iframe");f.src=origin+path;f.title=C.title;f.loading="lazy";
f.style.cssText="width:100%;max-width:"+(item?"420px":"100%")+";border:0;display:block;height:"+(item?C.h.item:C.h.store)+"px;color-scheme:normal";
s.after(f);
addEventListener("message",(e)=>{if(e.origin===origin&&e.source===f.contentWindow&&e.data&&e.data[K]==="height"&&typeof e.data.h==="number")f.style.height=Math.ceil(e.data.h)+"px";});});})();`;
}

/** The in-frame script for a given attr (must match the loader's). */
export function frameJs(attr = "nearkit"): string {
  const key = camel(checkAttr(attr));
  return `(()=>{const send=()=>parent.postMessage({${jsLiteral(key)}:"height",h:document.documentElement.scrollHeight,src:location.pathname},"*");
addEventListener("load",send);if(typeof ResizeObserver!=="undefined")new ResizeObserver(send).observe(document.body);send();})();`;
}

/** frameJs() with the default attr. Only a height leaves the frame, so "*" as target is fine. */
export const FRAME_JS = frameJs();

/** The snippets a site owner pastes. `base` = your public origin, e.g. "https://shop.example". */
export function snippets(o: { base: string; store: string; item?: string; attr?: string; pathFor?: Partial<PathTemplates>; height?: number }) {
  const attr = checkAttr(o.attr ?? "nearkit");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const paths = { ...DEFAULT_PATHS, ...o.pathFor };
  const path = (o.item ? paths.item : paths.store).replace("{store}", encodeURIComponent(o.store)).replace("{item}", encodeURIComponent(o.item ?? ""));
  const base = o.base.replace(/\/$/, "");
  return {
    script: `<script src="${esc(base)}/embed.js" data-${attr}-store="${esc(o.store)}"${o.item ? ` data-${attr}-item="${esc(o.item)}"` : ""} async></script>`,
    iframe: `<iframe src="${esc(base + path)}" title="Buy" loading="lazy" style="width:100%;max-width:${o.item ? "420px" : "100%"};height:${o.height ?? 640}px;border:0"></iframe>`,
  };
}
