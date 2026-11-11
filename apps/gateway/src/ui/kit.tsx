// Shared page kit for the seller app and onboarding (Figma "Nearchant"): layout, shell, icons, components.
import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import { contactLinks, type Contact } from "../contact.js";

const P: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  sparkles: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="15" r="1.2"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 5 5 9-10"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>', box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.8c1.9.7 3.1 2.5 3.5 5.2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>', tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>', link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 13v7h14v-7"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  flag: '<path d="M5 21V4h11l-1.5 4L16 12H5"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>', swap: '<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  msg: '<path d="M4 5h16v11H8l-4 4z"/>', phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>', eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.4-1"/>',
  bag: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>', person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.9-4 4.1-6.5 8-6.5s7.1 2.5 8 6.5"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.7 5.7 3.7 9s-1.2 6.3-3.7 9c-2.5-2.7-3.7-5.7-3.7-9S9.5 5.7 12 3z"/>',
};

export const Icon: FC<{ n: string; s?: number; c?: string }> = ({ n, s = 18, c }) =>
  // The colour goes through `style` so theme tokens work (an SVG stroke attribute can't read var(--…)).
  raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor"${c ? ` style="color:${c}"` : ""} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? ""}</svg>`);

/** Content fingerprints of the served assets: a deploy changes the URL, so Cloudflare's edge cache can't serve old
 *  CSS/JS with new pages. Set once at startup (routes.tsx / main.ts). */
export const assetV: Record<"css" | "js" | "checkout" | "buyer" | "wallet", string> = { css: "", js: "", checkout: "", buyer: "", wallet: "" };
export const asset = (path: string, k: keyof typeof assetV) => (assetV[k] ? `${path}?v=${assetV[k]}` : path);

export interface UiConfig { base: string; rpcUrl: string; network: string; token: string; decimals: number; storeBase: string; tokenContract?: string; accountSuffix?: string; videos?: boolean }

/** HTML page with the UI stylesheet, the client config and the app script. */
export const UiPage: FC<PropsWithChildren<{ title: string; cfg: UiConfig; page: string; test?: boolean; buyer?: boolean }>> = ({ title, cfg, page, test, buyer, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
      <title>{title}</title>
      <link rel="stylesheet" href={asset("/assets/ui.css", "css")} />
      <script type="application/json" id="nc-config" dangerouslySetInnerHTML={{ __html: JSON.stringify({ ...cfg, page }).replaceAll("<", "\\u003c") }}></script>
      <script type="module" src={asset("/assets/app.js", "js")}></script>
      {buyer ? <BuyerScripts network={cfg.network} /> : null}
    </head>
    <body>
      {test ? <div class="cap testbar">TEST network — payments use free test tokens</div> : null}
      {children}
    </body>
  </html>
);

const NAV = [["home", "Home", "/app"], ["sparkles", "Create", "/app/create"], ["grid", "Posts", "/app/posts"], ["bag", "Shop", "/app/shop"], ["box", "Orders", "/app/orders"], ["chart", "Analytics", "/app/analytics"], ["wallet", "Wallet", "/app/wallet"], ["sliders", "Settings", "/app/settings"]] as const;

export const Mark: FC<{ s?: number }> = ({ s = 28 }) => <span class="mark" style={`width:${s}px;height:${s}px`}>N</span>;

/** Seller app shell: desktop sidebar, mobile top bar + bottom nav (Figma web app + mobile web rows). */
export const Shell: FC<PropsWithChildren<{ active: string; store: { name: string; account: string; balance?: string } }>> = ({ active, store, children }) => (
  <div class="app">
    <aside class="side">
      <a class="logo" href="/app"><Mark />Nearchant</a>
      <RoleSwitch role="sell" />
      <nav class="nav">{NAV.map(([ic, label, href]) => <a href={href} class={label === active ? "on" : ""}><Icon n={ic} />{label}</a>)}</nav>
      <div class="grow"></div>
      <div class="wallet-mini">
        <span class="foot muted">{store.account}</span>
        <span class="t4">{store.balance ?? "—"}</span>
        <Badge label="Store verified on NEAR" />
      </div>
      <div class="sub" style="padding:12px 0 0 6px">{store.name}</div>
    </aside>
    <header class="topbar"><a class="logo" style="padding:0;gap:10px;min-width:0" href="/app"><Mark /><span class="stack" style="gap:0;min-width:0"><span class="callout b clamp1">{store.name}</span><span class="cap muted ellip">{store.account}</span></span></a><a class="acct-pill pay" href="/app/wallet" style="margin-left:auto;margin-right:4px"><Icon n="wallet" s={14} />{store.balance ?? "Wallet"}</a><a class="icon-btn" href="/feed" aria-label="Switch to shopping" title="Switch to shopping" style="margin:0 -2px 0 0"><Icon n="swap" s={22} /></a><a class={`icon-btn ${active === "Settings" || active === "Wallet" || active === "Analytics" ? "on" : ""}`} href="/app/settings" aria-label="Settings, wallet and analytics" style="margin:0 -10px 0 0"><Icon n="sliders" s={22} /></a></header>
    <main class="main">{children}</main>
    <nav class="bottomnav">
      {(["Home", "Posts", "Create", "Shop", "Orders"] as const).map((l) => NAV.find(([, x]) => x === l)!).map(([ic, label, href]) => label === "Create"
        ? <a href={href} aria-label="Create"><span class="fab"><Icon n="plus" s={24} /></span></a>
        : <a href={href} class={label === active ? "on" : ""}><Icon n={ic} s={22} />{label}</a>)}
    </nav>
  </div>
);

export const Badge: FC<{ label?: string }> = ({ label = "Verified on NEAR" }) => <span class="badge"><Icon n="shield" s={13} />{label}</span>;

export const Stat: FC<{ label: string; value: string; delta?: string; bars?: number[] }> = ({ label, value, delta, bars }) => (
  <div class="stat">
    <span class="foot muted">{label}</span>
    <span class="metric">{value}</span>
    {delta ? <span class="delta"><Icon n="trend" s={14} />{delta}</span> : null}
    {bars?.length ? <div class="spark">{bars.map((b) => <i style={`height:${Math.max(4, b)}%`}></i>)}</div> : null}
  </div>
);

export const PageHead: FC<PropsWithChildren<{ kicker: string; title: string }>> = ({ kicker, title, children }) => (
  <div class="head"><div><div class="kicker">{kicker}</div><h1 class="t1">{title}</h1></div><div class="row" style="align-items:center;gap:12px">{children}</div></div>
);

/** Create flow steps (Figma Web · Create 1–3): Photos & idea → AI makes it → Review & publish. */
export const CreateSteps: FC<{ step: 1 | 2 | 3 }> = ({ step }) => (
  <div class="csteps">{["Photos & idea", "AI makes it", "Review & publish"].map((t, i) => (
    <>{i ? <span class="csteps-line"></span> : null}<span class={`csteps-s ${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}`}><i>{i + 1 < step ? "✓" : i + 1}</i><span class="csteps-t">{t}</span></span></>
  ))}</div>
);

/** Buyer scripts (ADR 0022): likes, reports, sign-in; the wallet chooser loads on demand. */
export const BuyerScripts: FC<{ network: string; main?: string | undefined; mainPath?: string | undefined }> = ({ network, main, mainPath }) => (
  <>
    <script type="application/json" id="nc-buyer" dangerouslySetInnerHTML={{ __html: JSON.stringify({ network, walletJs: asset("/assets/wallet.js", "wallet"), main, mainPath }).replaceAll("<", "\\u003c") }}></script>
    <script type="module" src={asset("/assets/buyer.js", "buyer")}></script>
  </>
);

/** Tap-to-open contact rows (messenger, call, email) with a copy button each — iOS grouped list style. */
export const ContactList: FC<{ c: Contact }> = ({ c }) => (
  <div class="list">{contactLinks(c).map((l) => (
    <div class="list-row">
      <a class="list-main" href={l.href} {...(l.href.startsWith("http") ? { target: "_blank", rel: "noopener" } : {})}>
        <span class="list-ic" style={`background:${l.label === "Email" ? "var(--blue)" : l.label === "Call" ? "var(--green)" : l.label === "WhatsApp" ? "#25d366" : l.label === "Telegram" ? "#2aabee" : "var(--indigo)"}`}><Icon n={l.label === "Email" ? "mail" : l.label === "Call" ? "phone" : "msg"} s={16} c="#fff" /></span>
        <span class="list-text"><span class="body">{l.label}</span><span class="foot muted">{l.value}</span></span>
      </a>
      <button class="icon-btn" type="button" data-copy={l.value} aria-label={`Copy ${l.value}`}><Icon n="copy" s={18} /></button>
    </div>))}
  </div>
);

/** iOS-style segmented control. Plain links (server pages) or buttons with data-seg (client side). */
export const Segmented: FC<{ items: { label: string; href?: string; value?: string; on: boolean }[]; name?: string }> = ({ items, name }) => (
  <div class="seg" role="tablist" {...(name ? { "data-seg": name } : {})}>{items.map((x) => x.href
    ? <a href={x.href} role="tab" aria-selected={x.on ? "true" : "false"} class={x.on ? "on" : ""}>{x.label}</a>
    : <button type="button" role="tab" data-value={x.value} aria-selected={x.on ? "true" : "false"} class={x.on ? "on" : ""}>{x.label}</button>)}</div>
);

/** Buyer navigation (8 Nov): the same places on every buyer page — the feed, stores you follow, posts you liked, your
 *  orders and your account. Phone: a bottom tab bar; desktop: links in the header (BuyerLinks). Links are absolute
 *  to the main site, because a store's own subdomain doesn't share the buyer's sign-in. */
export type BuyerTab = "feed" | "following" | "liked" | "orders" | null;
const BUYER_TABS = [["feed", "grid", "Shop", "/feed"], ["following", "users", "Following", "/feed/following"], ["liked", "heart", "Liked", "/feed/liked"], ["orders", "box", "Orders", "/feed/orders"]] as const;
export const BuyerTabs: FC<{ active: BuyerTab; site?: string }> = ({ active, site = "" }) => (
  <nav class="buyertabs" aria-label="Shopping">
    {BUYER_TABS.map(([k, ic, label, href]) => <a href={`${site}${href}`} class={active === k ? "on" : ""} aria-current={active === k ? "page" : undefined}><Icon n={ic} s={22} />{label}</a>)}
    <a href="#" data-buyer-me data-buyer-tab><Icon n="person" s={22} /><span data-buyer-label>Sign in</span></a>
  </nav>
);
export const BuyerLinks: FC<{ active: BuyerTab; site?: string }> = ({ active, site = "" }) => (
  <span class="buyerlinks sub">{BUYER_TABS.map(([k, , label, href]) => <a href={`${site}${href}`} class={active === k ? "on" : ""}>{k === "feed" ? "Shop feed" : k === "orders" ? "My orders" : label}</a>)}
    <a href="#" data-buyer-me><span data-buyer-label>Sign in</span></a><SellLink site={site} /></span>
);

/** Shopping → selling (buyer pages). "/sell" opens the store this browser is signed in to, or creating one; buyer.ts
 *  relabels it "Your store" when there is one. */
export const SellLink: FC<{ site?: string; cls?: string }> = ({ site = "", cls = "" }) => (
  <a class={`btn sm secondary sell-link ${cls}`} href={`${site}/sell`} data-sell-link><Icon n="store" s={15} /><span data-sell-label>Sell on Nearchant</span></a>
);

/** Selling ↔ shopping, the same two places for everyone: the seller app (Selling) and the shop feed (Shopping). */
export const RoleSwitch: FC<{ role: "sell" | "buy"; site?: string }> = ({ role, site = "" }) => (
  <div class="seg role-switch" role="tablist" aria-label="Selling or shopping">
    <a href={`${site}/sell`} role="tab" aria-selected={role === "sell" ? "true" : "false"} class={role === "sell" ? "on" : ""}>Selling</a>
    <a href={`${site}/feed`} role="tab" aria-selected={role === "buy" ? "true" : "false"} class={role === "buy" ? "on" : ""}>Shopping</a>
  </div>
);
