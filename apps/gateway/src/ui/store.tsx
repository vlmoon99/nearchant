// Buyer storefront (Figma "Storefront for buyers"): store page + item page with the existing escrow checkout
// (web/checkout.ts hooks onto form.order[data-service] and the #nc-config tag).
import type { FC, PropsWithChildren } from "hono/jsx";
import { Badge, Icon, asset } from "./kit.js";

export interface StoreItem { id: string; title: string; description: string; price: string; img: string | null; kind: string; options: string[] }
export interface StorePost { caption: string; img: string | null; video?: string | null; proofId: string | null }
export interface StoreData { handle: string; name: string; account: string; summary: string; items: StoreItem[]; posts: StorePost[]; orders: number }
export interface CheckoutCfg { base: string; rpcUrl: string; orders: string; network: string }

const Shell: FC<PropsWithChildren<{ title: string; s: StoreData; cfg: CheckoutCfg; test: boolean }>> = ({ title, s, cfg, test, children }) => (
  <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>{title}</title><link rel="stylesheet" href={asset("/assets/ui.css", "css")} />
    <script type="application/json" id="nc-config" dangerouslySetInnerHTML={{ __html: JSON.stringify(cfg).replaceAll("<", "\\u003c") }}></script>
    <script type="module" src={asset("/assets/checkout.js", "checkout")}></script></head>
    <body>
      {test ? <div class="cap" style="text-align:center;padding:4px;background:#fff3c4;color:#5c4a00">TEST network — payments use free test tokens</div> : null}
      <header class="spread" style="padding:14px 20px;border-bottom:1px solid var(--sep)">
        <a class="row" href={cfg.base} style="align-items:center;gap:10px;color:inherit"><span class="dot" style="width:28px;height:28px;background:linear-gradient(135deg,#ff9966,#b052de)"></span><span class="headline">{s.name}</span></a>
        <span class="foot muted">Powered by Nearchant</span>
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
      <Badge label="Store verified on NEAR" />
      <span class="cap muted">{s.account}{s.orders ? ` · ${s.orders} order${s.orders === 1 ? "" : "s"} paid through escrow` : ""}</span>
    </section>
    <h2 class="t4">Shop</h2>
    {s.items.length ? <div class="grid4">{s.items.map((i) => (
      <a class="post" href={`${cfg.base}i/${i.id}`} style="color:inherit">
        <div class="img" style={i.img ? `background-image:url('${i.img}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div>
        <div class="spread"><span class="sub b">{i.title}</span><span class="sub b">{i.price}</span></div>
        {i.options.length ? <span class="foot muted">{i.options.join(" · ")}</span> : null}
      </a>))}</div> : <p class="sub muted">Nothing for sale yet — check back soon.</p>}
    {s.posts.length ? <><h2 class="t4">Latest posts</h2><div class="grid4">{s.posts.map((p) => (
      <div class="post">{p.video ? <video class="img" src={p.video} poster={p.img ?? undefined} controls playsinline preload="none" style="aspect-ratio:9/16;object-fit:cover;width:100%"></video> : <div class="img" style={p.img ? `background-image:url('${p.img}')` : ""}></div>}<span class="foot">{p.caption.slice(0, 120)}</span>{p.proofId ? <Badge label={`Proof #${p.proofId} on NEAR`} /> : null}</div>))}</div></> : null}
    <div class="card proof" style="flex-direction:row;gap:14px;align-items:center"><Icon n="shield" s={24} c="#007A4F" />
      <span class="stack s8" style="gap:4px"><span class="headline proof-t">Safe to buy</span><span class="foot">Pay in test USDC (nUSD). Your money waits in escrow on NEAR and goes to {s.name} only when you confirm you got your order. Not delivered in time? You get it back automatically.</span></span></div>
  </Shell>
);

export const ItemPage: FC<{ s: StoreData; i: StoreItem; cfg: CheckoutCfg; test: boolean }> = ({ s, i, cfg, test }) => (
  <Shell title={`${i.title} · ${s.name}`} s={s} cfg={cfg} test={test}>
    <a class="sub" href={cfg.base}>‹ {s.name}</a>
    <div class="cols post-cols">
      <div class="post"><div class="img" style={i.img ? `background-image:url('${i.img}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div></div>
      <div class="stack">
        <h1 class="t2">{i.title}</h1>
        <span class="t4">{i.price}</span>
        {i.description ? <p class="sub muted" style="margin:0">{i.description}</p> : null}
        <form class="order card" data-service={i.id}>
          <label class="field">{i.kind === "service" ? "What do you need, and when?" : "Delivery details — size, name, address, phone"}
            <textarea class="input" name="brief" required minlength={10} maxlength={1000} rows={4} placeholder={i.kind === "service" ? "Describe what you need" : `Size ${i.options[0] ?? "M"}, Jane Doe, 120 Spring St, New York, NY 10012, +1 212 555 0100`}></textarea></label>
          <button class="btn block" type="submit"><Icon n="lock" />Pay {i.price} into escrow</button>
          <output class="result foot"></output>
          <span class="cap muted">A free test wallet is created in your browser. Money is held on NEAR until you confirm you got it.</span>
        </form>
      </div>
    </div>
  </Shell>
);

/** Buyer's order page for a store item (Figma "Order paid"): paid → shipped → you confirm. Buttons are handled by
 *  web/checkout.ts (data-order-action / #order-msg / data-poll-order), so the escrow logic is shared with decks. */
export const ItemOrderPage: FC<{ s: StoreData; cfg: CheckoutCfg; test: boolean; o: { orderId: string; title: string; amount: string; chainStatus: string | null } }> = ({ s, cfg, test, o }) => {
  const st = o.chainStatus;
  const step = st === "Released" ? 3 : st === "Delivered" ? 2 : st === "Held" ? 1 : 0;
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
        <h1 class="t2">{st === "Released" ? "Done — thank you!" : st === "Delivered" ? "Shipped — confirm when you get it" : st === "Held" ? "Paid — safe in escrow" : st === "Refunded" ? "Refunded" : "Waiting for payment…"}</h1>
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
      <div class="card proof" style="flex-direction:row;gap:10px;align-items:center"><Icon n="shield" c="#007A4F" /><span class="stack" style="gap:2px"><span class="foot b proof-t">Escrow on NEAR · {cfg.orders}</span><span class="cap muted">Order {o.orderId} — anyone can check it on the NEAR explorer</span></span></div>
    </Shell>
  );
};
