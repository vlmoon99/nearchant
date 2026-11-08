// Buy widget (ADR 0027): a compact card of one item, or the shop's items, for an <iframe> on any website. The button
// opens the item on Nearchant in a new tab, where the buyer pays into escrow; nothing is paid inside the frame.
import type { FC } from "hono/jsx";
import { Icon, asset } from "./kit.js";
import type { StoreData, StoreItem } from "./store.js";
import { itemFacts, soldOut } from "../item-details.js";

export const EmbedPage: FC<{ s: StoreData; items: StoreItem[]; storeUrl: string }> = ({ s, items, storeUrl }) => (
  <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{items.length === 1 ? `${items[0]!.title} · ${s.name}` : s.name}</title>
    <link rel="stylesheet" href={asset("/assets/ui.css", "css")} /><script src="/assets/embed-frame.js" defer></script></head>
    <body class="embed">
      <div class={items.length === 1 ? "embed-one" : "embed-grid"}>
        {items.map((i) => {
          const d = i.details ?? {}, gone = soldOut(i.kind, d), url = `${storeUrl}i/${i.id}?ref=widget`;
          return <article class="embed-card">
            <a class={`embed-img${i.img ? "" : " noimg"}`} href={url} target="_blank" rel="noopener" style={i.img ? `background-image:url('${i.img}')` : "aspect-ratio:2/1"} aria-label={i.title}>{i.img ? null : <Icon n={i.kind === "service" ? "users" : "bag"} s={36} c="var(--label-3)" />}</a>
            <div class="embed-body">
              <span class="cap muted clamp1">{s.name}</span>
              <span class="headline clamp2">{i.title}</span>
              <span class="sub b">{d.priceFrom ? "From " : ""}{i.price}</span>
              <span class="cap muted clamp1">{gone ? "Sold out" : itemFacts(i.kind, d).join(" · ")}</span>
              {gone ? <span class="btn secondary block" aria-disabled="true">Sold out</span>
                : <a class="btn block" href={url} target="_blank" rel="noopener">{i.kind === "service" ? "Book" : "Buy"} · {i.price}</a>}
              <span class="cap muted embed-trust">🔒 Safe payment · escrow on NEAR</span>
            </div>
          </article>;
        })}
        {!items.length ? <p class="sub muted">Nothing for sale right now.</p> : null}
      </div>
      <a class="cap muted embed-foot" href={storeUrl} target="_blank" rel="noopener">{s.name} on Nearchant ›</a>
    </body></html>
);

export const EmbedMissing: FC = () => (
  <html lang="en"><head><meta charset="utf-8" /><link rel="stylesheet" href="/assets/ui.css" /></head>
    <body class="embed"><p class="sub muted" style="padding:16px">This item isn't for sale any more.</p></body></html>
);

/** Inside the frame: tell the page that holds it how tall the widget is (so it never scrolls inside). */
export const EMBED_FRAME_JS = `(()=>{const send=()=>parent.postMessage({nearchant:"height",h:document.documentElement.scrollHeight,src:location.pathname},"*");
addEventListener("load",send);new ResizeObserver(send).observe(document.body);send();})();`;

/** On another website: <script src="https://nearchant.com/embed.js" data-nearchant-store="h" data-nearchant-item="i-…" async></script>
 *  puts the widget where the script tag is, sized to its content. */
export const EMBED_LOADER_JS = `(()=>{const me=document.currentScript;const origin=new URL(me.src).origin;
const tags=document.querySelectorAll("script[data-nearchant-store]");
tags.forEach((s)=>{if(s.dataset.nearchantDone)return;s.dataset.nearchantDone="1";
const store=encodeURIComponent(s.dataset.nearchantStore),item=s.dataset.nearchantItem;
const f=document.createElement("iframe");f.src=origin+"/h/"+store+"/embed"+(item?"/i/"+encodeURIComponent(item):"");
f.title="Buy on Nearchant";f.loading="lazy";f.style.cssText="width:100%;max-width:"+(item?"420px":"100%")+";border:0;display:block;height:"+(item?"520":"640")+"px;color-scheme:normal";
s.after(f);
addEventListener("message",(e)=>{if(e.origin===origin&&e.source===f.contentWindow&&e.data&&e.data.nearchant==="height")f.style.height=Math.ceil(e.data.h)+"px";});});})();`;
