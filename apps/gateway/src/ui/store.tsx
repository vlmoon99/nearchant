// Buyer storefront (Figma "Storefront for buyers"): store page + item page with the existing escrow checkout
// (web/checkout.ts hooks onto form.order[data-service] and the #nc-config tag).
import type { FC, PropsWithChildren } from "hono/jsx";
import { Badge, BuyerScripts, ContactList, Icon, asset } from "./kit.js";
import { APPS, type Contact } from "../contact.js";
import { itemFacts, ships, soldOut, type ItemDetails } from "../item-details.js";

export interface StoreItem { id: string; title: string; description: string; price: string; img: string | null; kind: string; options: string[]; details?: ItemDetails }
export interface StorePost { id: string; itemId?: string | null; publishedAt: string; hashtags?: string[]; caption: string; img: string | null; video?: string | null; proofId: string | null; likes?: number }
/** A post of another store shown under "More like this". */
export interface SimilarPost { id: string; handle: string; storeName: string; caption: string; img: string; video: boolean }
export interface StoreData { handle: string; name: string; account: string; summary: string; items: StoreItem[]; posts: StorePost[]; orders: number }
export interface CheckoutCfg { base: string; rpcUrl: string; orders: string; network: string; /** The main site (buyer accounts live there; store subdomains send buyers to it). */ site?: string }

/** Link preview (Open Graph) for shared store, post and item links. */
export interface OgMeta { title: string; description: string; url: string; image?: string | null }

const Shell: FC<PropsWithChildren<{ title: string; s: StoreData; cfg: CheckoutCfg; test: boolean; og?: OgMeta }>> = ({ title, s, cfg, test, og, children }) => (
  <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>{title}</title>
    {og ? <><meta property="og:type" content="article" /><meta property="og:site_name" content={s.name} /><meta property="og:title" content={og.title} />
      <meta property="og:description" content={og.description} /><meta property="og:url" content={og.url} /><meta name="description" content={og.description} />
      {og.image ? <><meta property="og:image" content={og.image} /><meta name="twitter:card" content="summary_large_image" /></> : null}</> : null}<link rel="stylesheet" href={asset("/assets/ui.css", "css")} />
    <script type="application/json" id="nc-config" dangerouslySetInnerHTML={{ __html: JSON.stringify(cfg).replaceAll("<", "\\u003c") }}></script>
    <script type="module" src={asset("/assets/checkout.js", "checkout")}></script><BuyerScripts network={cfg.network} main={cfg.site} mainPath={`/h/${s.handle}`} /></head>
    <body>
      {test ? <div class="cap" style="text-align:center;padding:4px;background:#fff3c4;color:#5c4a00">TEST network — payments use free test tokens</div> : null}
      <header class="spread" style="padding:14px 20px;border-bottom:1px solid var(--sep)">
        <a class="row" href={cfg.base} style="align-items:center;gap:10px;color:inherit"><span class="dot" style="width:28px;height:28px;background:linear-gradient(135deg,#ff9966,#b052de)"></span><span class="headline">{s.name}</span></a>
        <span class="row" style="gap:14px;align-items:center"><a class="foot" href="/feed">Shop feed</a><a class="foot" href="#" data-buyer-me>Sign in</a></span>
      </header>
      <main class="stack" style="max-width:1200px;margin:0 auto;padding:24px 20px 80px;gap:24px">{children}</main>
    </body></html>
);

export const StorePage: FC<{ s: StoreData; cfg: CheckoutCfg; test: boolean }> = ({ s, cfg, test }) => (
  <Shell title={`${s.name} · shop`} s={s} cfg={cfg} test={test}>
    <section class="card" style="background:linear-gradient(135deg,#e6edff,#fbeee2);align-items:center;text-align:center;gap:10px;padding:28px">
      <span class="dot" style="width:72px;height:72px;background:linear-gradient(135deg,#ff9966,#b052de)"></span>
      <h1 class="tl">{s.name}</h1>
      {s.summary ? <p class="sub muted" style="margin:0">{s.summary}</p> : null}
      <div class="row" style="gap:10px;align-items:center;justify-content:center;flex-wrap:wrap"><Badge label="Store verified on NEAR" />
        <button class="btn secondary follow" type="button" data-follow={s.handle} aria-pressed="false" style="padding:7px 16px"><Icon n="plus" s={14} /><span data-l>Follow</span><span class="muted" data-n></span></button></div>
      <span class="cap muted">{s.account}{s.orders ? ` · ${s.orders} order${s.orders === 1 ? "" : "s"} paid through escrow` : ""}</span>
    </section>
    <h2 class="t4">Shop</h2>
    {s.items.length ? <div class="grid4">{s.items.map((i) => (
      <a class="post" href={`${cfg.base}i/${i.id}`} style="color:inherit">
        <div class="img" style={i.img ? `background-image:url('${i.img}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div>
        <div class="spread" style="align-items:flex-start"><span class="sub b">{i.title}</span><span class="sub b" style="white-space:nowrap">{i.details?.priceFrom ? "from " : ""}{i.price}</span></div>
        <span class="foot muted">{soldOut(i.kind, i.details ?? {}) ? "Sold out" : itemFacts(i.kind, i.details ?? {}).join(" · ")}</span>
      </a>))}</div> : <p class="sub muted">Nothing for sale yet — check back soon.</p>}
    <AskStore s={s} cfg={cfg} />
    {s.posts.length ? <><div class="spread"><h2 class="t4">Posts</h2>{s.posts.length > 8 ? <a class="sub" href={`${cfg.base}posts`}>All {s.posts.length} posts ›</a> : null}</div>
      <div class="grid4">{s.posts.slice(0, 8).map((p) => <PostTile p={p} base={cfg.base} />)}</div></> : null}
    <div class="card proof" style="flex-direction:row;gap:14px;align-items:center"><Icon n="shield" s={24} c="#007A4F" />
      <span class="stack s8" style="gap:4px;flex:1;min-width:0"><span class="headline proof-t">Safe to buy</span><span class="foot">Pay in test USDC (nUSD). Your money waits in escrow on NEAR and goes to {s.name} only when you confirm you got your order. Not delivered in time? You get it back automatically.</span></span></div>
    <span class="cap muted" style="text-align:center">Something wrong with this store? <a href="#" data-report-store={s.handle}>Report it</a></span>
  </Shell>
);

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "America/New_York" });

/** A post in a store's feed: picture (▶ when it has a short) → the post page. */
export const PostTile: FC<{ p: StorePost; base: string }> = ({ p, base }) => (
  <a class="post" href={`${base}p/${p.id}`} style="color:inherit">
    <div class="img" style={`aspect-ratio:4/5;position:relative;${p.img ? `background-image:url('${p.img}')` : ""}`}>
      {p.video ? <span class="dot" style="position:absolute;top:10px;right:10px;width:30px;height:30px;background:rgba(0,0,0,.55)"><Icon n="play" s={14} c="#fff" /></span> : null}</div>
    <div class="spread" style="gap:8px;align-items:flex-start"><span class="foot clamp3" style="min-width:0">{p.caption}</span>
      <button class="like" type="button" data-like={p.id} aria-pressed="false" aria-label="Like"><Icon n="heart" s={16} /><span data-n>{p.likes || ""}</span></button></div>
    {p.proofId ? <Badge label={`Proof #${p.proofId} on NEAR`} /> : null}
  </a>
);

/** All posts of a store — the store's own feed, so buyers don't need another social network to follow it. */
export const PostsPage: FC<{ s: StoreData; cfg: CheckoutCfg; test: boolean }> = ({ s, cfg, test }) => (
  <Shell title={`Posts · ${s.name}`} s={s} cfg={cfg} test={test}>
    <a class="sub" href={cfg.base}>‹ {s.name}</a>
    <h1 class="t2">Posts</h1>
    <div class="grid4">{s.posts.map((p) => <PostTile p={p} base={cfg.base} />)}</div>
  </Shell>
);

/** One post, public: the picture or short, the caption, its proof on NEAR, the item it shows (Buy) and share links. */
export const PublicPostPage: FC<{ s: StoreData; p: StorePost; cfg: CheckoutCfg; test: boolean; url: string; og: OgMeta; verifyUrl: string | null; similar?: SimilarPost[]; site?: string }> = ({ s, p, cfg, test, url, og, verifyUrl, similar = [], site = "" }) => {
  const item = p.itemId ? s.items.find((i) => i.id === p.itemId) : undefined;
  const more = s.posts.filter((x) => x.id !== p.id).slice(0, 4);
  const share = encodeURIComponent(`${url}?ref=share`), text = encodeURIComponent(`${s.name}: ${p.caption.slice(0, 120)}`);
  return (
    <Shell title={`${s.name}: ${p.caption.slice(0, 60)}`} s={s} cfg={cfg} test={test} og={og}>
      <a class="sub" href={cfg.base}>‹ {s.name}</a>
      <div class="cols post-cols">
        <div class="post">{p.video
          ? <video class="img" src={p.video} poster={p.img ?? undefined} controls playsinline preload="metadata" style="aspect-ratio:9/16;max-height:80vh;object-fit:cover;background:#000"></video>
          : <div class="img" style={`aspect-ratio:4/5;${p.img ? `background-image:url('${p.img}')` : ""}`}></div>}</div>
        <div class="stack" style="gap:16px">
          <div class="row" style="align-items:center;gap:10px"><span class="dot" style="width:36px;height:36px;background:linear-gradient(135deg,#ff9966,#b052de)"></span>
            <span class="stack" style="gap:0"><a class="headline" href={cfg.base} style="color:inherit">{s.name}</a><span class="cap muted">{when(p.publishedAt)}</span></span></div>
          <p class="body" style="margin:0;white-space:pre-line">{p.caption}</p>
          {p.hashtags?.length ? <span class="foot" style="color:#007AFF">{p.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}</span> : null}
          {p.proofId ? <a class="card proof" href={verifyUrl ?? "#"} style="flex-direction:row;gap:12px;align-items:center;color:inherit"><Icon n="shield" s={22} c="#007A4F" />
            <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="callout b proof-t">Proof #{p.proofId} on NEAR</span><span class="cap muted">Who published it, when, and that it was not changed — check it</span></span><Icon n="chevron" s={16} /></a> : null}
          {item ? <a class="card white" href={`${cfg.base}i/${item.id}`} style="flex-direction:row;gap:12px;align-items:center;color:inherit;padding:12px">
            <span style={`width:56px;height:70px;border-radius:10px;flex:none;background:#eee center/cover ${item.img ? `url('${item.img}')` : ""}`}></span>
            <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="callout b">{item.title}</span><span class="foot muted">{item.price} · paid safely through escrow on NEAR</span></span>
            <span class="btn">Buy</span></a>
            : s.items.length ? <a class="btn" href={cfg.base}>Shop {s.name}</a> : null}
          <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
            <button class="chip like" type="button" data-like={p.id} aria-pressed="false"><Icon n="heart" s={16} /><span>Like</span><span data-n>{p.likes || ""}</span></button>
            <button class="chip" type="button" data-report-post={p.id}><Icon n="flag" s={14} />Report</button></div>
          <AskStore s={s} cfg={cfg} placeholder="Ask about this — size, material, delivery…" />
          <div class="row" style="gap:8px;flex-wrap:wrap"><span class="foot muted">Share</span>
            <a class="chip" href={`https://t.me/share/url?url=${share}&text=${text}`} target="_blank" rel="noopener"><Icon n="send" s={14} />Telegram</a>
            <a class="chip" href={`https://x.com/intent/post?url=${share}&text=${text}`} target="_blank" rel="noopener">X</a>
            <a class="chip" href={`https://wa.me/?text=${text}%20${share}`} target="_blank" rel="noopener">WhatsApp</a></div>
        </div>
      </div>
      {more.length ? <><div class="spread"><h2 class="t4">More from {s.name}</h2><a class="sub" href={`${cfg.base}posts`}>All posts ›</a></div>
        <div class="grid4">{more.map((x) => <PostTile p={x} base={cfg.base} />)}</div></> : null}
      {similar.length ? <><div class="spread"><h2 class="t4">More like this on Nearchant</h2><a class="sub" href={`${site}/feed`}>Shop feed ›</a></div>
        <div class="grid4">{similar.slice(0, 4).map((x) => <a class="post" href={`${site}/h/${x.handle}/p/${x.id}?ref=similar`} style="color:inherit">
          <div class="img" style={`aspect-ratio:4/5;position:relative;background-image:url('${site}${x.img}')`}>{x.video ? <span class="dot" style="position:absolute;top:10px;right:10px;width:30px;height:30px;background:rgba(0,0,0,.55)"><Icon n="play" s={14} c="#fff" /></span> : null}</div>
          <span class="foot b">{x.storeName}</span><span class="foot clamp2">{x.caption}</span></a>)}</div></> : null}
    </Shell>
  );
};

export const ItemPage: FC<{ s: StoreData; i: StoreItem; cfg: CheckoutCfg; test: boolean }> = ({ s, i, cfg, test }) => {
  const d = i.details ?? {}, service = i.kind === "service", gone = soldOut(i.kind, d), needsAddress = ships(i.kind, d);
  return (
    <Shell title={`${i.title} · ${s.name}`} s={s} cfg={cfg} test={test}>
      <a class="sub" href={cfg.base}>‹ {s.name}</a>
      <div class="cols post-cols">
        <div class="post"><div class="img" style={i.img ? `background-image:url('${i.img}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div></div>
        <div class="stack">
          <div class="stack s8"><h1 class="t2">{i.title}</h1>
            <span class="t4">{d.priceFrom ? "From " : ""}{i.price}</span>
            <span class="foot muted">{gone ? "Sold out" : itemFacts(i.kind, d).join(" · ")}</span></div>
          {i.description ? <p class="body" style="margin:0;white-space:pre-line">{i.description}</p> : null}
          {gone ? <div class="card"><span class="headline">Sold out</span><span class="foot muted">Follow {s.name} to see when it is back.</span></div> :
          <form class="order stack" data-service={i.id} style="gap:20px">
            {i.options.length ? <div class="group"><span class="group-h">{d.optionName || "Choose"}</span>
              <div class="seg" data-seg="option">{i.options.map((o, k) => <button type="button" data-value={o} class={k === 0 ? "on" : ""} aria-selected={k === 0 ? "true" : "false"}>{o}</button>)}</div>
              <input type="hidden" name="option" value={i.options[0]} /></div> : null}
            <div class="group"><span class="group-h">{service ? "Your request" : "Note for the store"}</span>
              <div class="list"><label class="list-field"><span class="sr">{service ? d.question || "What do you need, and when?" : "Note"}</span>
                <textarea name="brief" rows={3} maxlength={1000} {...(service && d.question ? { required: true } : {})} placeholder={service ? d.question || "What do you need, and when?" : "Size, engraving, anything the store should know (optional)"}></textarea></label></div>
              {service && d.priceFrom ? <span class="group-f">You pay {i.price} now. If the final price is higher, {s.name} agrees it with you directly.</span> : null}</div>
            <div class="group"><span class="group-h">How can {s.name} reach you?</span>
              <div class="list">
                <label class="list-field"><span>Name</span><input name="name" required minlength={2} maxlength={80} autocomplete="name" placeholder="Your name" /></label>
                <label class="list-field"><span>Phone</span><input name="phone" type="tel" autocomplete="tel" placeholder="+1 212 555 0100" /></label>
                <label class="list-field"><span>On</span><select name="app">{Object.entries(APPS).map(([v, l]) => <option value={v} selected={v === "whatsapp"}>{l}</option>)}</select></label>
                <label class="list-field"><span>Email</span><input name="email" type="email" autocomplete="email" placeholder="you@example.com" /></label>
                {needsAddress ? <label class="list-field top"><span>Address</span><textarea name="address" rows={2} required minlength={8} maxlength={300} autocomplete="street-address" placeholder="Street, city, postcode, country"></textarea></label> : null}
              </div>
              <span class="group-f">A phone or an email is enough. Only {s.name} sees it, to arrange {service ? "the details" : "delivery"} with you.</span></div>
            <button class="btn block lg" type="submit"><Icon n="lock" />Pay {i.price}</button>
            <output class="result foot" aria-live="polite"></output>
            <span class="cap muted" style="text-align:center">Your money waits in escrow on NEAR and goes to {s.name} only when you confirm. A free test wallet is made in this browser.</span>
          </form>}
        </div>
      </div>
    </Shell>
  );
};

/** Buyer's order page for a store item (Figma "Order paid"): paid → shipped → you confirm. Buttons are handled by
 *  web/checkout.ts (data-order-action / #order-msg / data-poll-order), so the escrow logic is shared with decks. */
export const ItemOrderPage: FC<{ s: StoreData; cfg: CheckoutCfg; test: boolean; o: { orderId: string; title: string; amount: string; chainStatus: string | null }; storeContact?: Contact | null }> = ({ s, cfg, test, o, storeContact }) => {
  const st = o.chainStatus;
  const step = st === "Released" ? 4 : st === "Delivered" ? 2 : st === "Held" ? 1 : 0;
  const rows: [string, string][] = [
    ["Paid", "Your money is held in escrow on NEAR"],
    [`${s.name} ships it`, "Recorded on NEAR when it is shipped"],
    ["You confirm you got it", "Or it confirms itself after the deadline"],
    ["Payment released to the store", `Escrow → ${s.account}`],
  ];
  return (
    <Shell title={`Order · ${s.name}`} s={s} cfg={cfg} test={test}>
      <a class="sub" href={cfg.base}>‹ {s.name}</a>
      <section class="card" style="align-items:center;text-align:center;gap:10px" {...(st === "Held" || st === "Opening" || !st ? { "data-poll-order": o.orderId } : {})}>
        <span class={`dot ${step >= 1 ? "ok" : "now"}`} style="width:64px;height:64px"><Icon n={step >= 1 ? "check" : "lock"} s={32} /></span>
        <h1 class="t2">{st === "Released" ? "Done — thank you!" : st === "Delivered" ? "Shipped — confirm when you get it" : st === "Held" ? "Paid — safe in escrow" : st === "Refunded" ? "Refunded — the money is back in your wallet"
          : st === "RevisionRequested" ? "The store will make it right" : st === "RefundRequested" ? "Refund requested — the store will answer" : st === "Disputed" ? "The store declined the refund — contact them below"
          : st === "Refunding" ? "Refunding…" : st === "Releasing" ? "Paying the store…" : "Waiting for payment…"}</h1>
        <span class="sub muted">{o.amount} · {o.title} · {s.name}</span>
      </section>
      <section class="card" style="gap:0">
        {rows.map(([t, d], i) => (
          <div class="row" style={`gap:12px;padding:${i ? "14px" : "0"} 0 0 0`}>
            <span class={`dot ${i < step ? "ok" : i === step ? "now" : "todo"}`}>{i < step ? <Icon n="check" s={14} /> : <span class="cap b">{i + 1}</span>}</span>
            <span class="stack" style="gap:2px"><span class={`callout b ${i > step ? "muted" : ""}`}>{t}</span><span class="foot muted">{d}</span></span>
          </div>))}
      </section>
      {st === "Delivered" ? <div class="stack s12"><button class="btn block" data-order-action="accept" data-order={o.orderId}><Icon n="check" />I got it — release payment</button><button class="btn secondary block" data-order-action="request_refund" data-order={o.orderId}>Problem — request a refund</button></div> : null}
      <output id="order-msg" class="foot"></output>
      {st && st !== "Opening" ? <section class="group">
        <span class="group-h">Contact {s.name}</span>
        {storeContact ? <ContactList c={storeContact} /> : <div class="list"><div class="list-row"><span class="list-text"><span class="foot muted">{s.name} will contact you using the details you gave.</span></span></div></div>}
        <span class="group-f">Questions about your order? Write to {s.name} directly. Never pay outside the order — escrow protects your money. Bookmark this page: it is how you get back to your order.</span>
      </section> : null}
      <div class="card proof" style="flex-direction:row;gap:10px;align-items:center"><Icon n="shield" c="#007A4F" /><span class="stack" style="gap:2px"><span class="foot b proof-t">Escrow on NEAR · {cfg.orders}</span><span class="cap muted">Order {o.orderId} — anyone can check it on the NEAR explorer</span></span></div>
    </Shell>
  );
};

/** "Ask the store" box (ADR 0022): the store's AI assistant answers from the store's own public information. */
export const AskStore: FC<{ s: StoreData; cfg: CheckoutCfg; placeholder?: string }> = ({ s, cfg, placeholder }) => (
  <form class="card ask" data-ask action={`${cfg.base}public/ask`} style="gap:8px">
    <div class="row" style="gap:8px;align-items:center"><Icon n="sparkles" s={18} c="#AF52DE" /><span class="headline">Ask {s.name}</span></div>
    <div class="row" style="gap:8px"><input class="input" name="question" required minlength={3} maxlength={500} placeholder={placeholder ?? "Sizes, delivery, what's it made of…"} style="flex:1" /><button class="btn" type="submit">Ask</button></div>
    <output class="sub" aria-live="polite"></output>
    <span class="cap muted">Answered by the store's AI from its public info. To buy, use “Pay into escrow” on the item.</span>
  </form>
);
