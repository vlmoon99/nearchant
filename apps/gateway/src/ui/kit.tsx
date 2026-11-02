// Shared page kit for the seller app and onboarding (Figma "Nearchant"): layout, shell, icons, components.
import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";

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
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  msg: '<path d="M4 5h16v11H8l-4 4z"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.7 5.7 3.7 9s-1.2 6.3-3.7 9c-2.5-2.7-3.7-5.7-3.7-9S9.5 5.7 12 3z"/>',
};

export const Icon: FC<{ n: string; s?: number; c?: string }> = ({ n, s = 18, c }) =>
  raw(`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c ?? "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? ""}</svg>`);

/** Content fingerprints of the served assets: a deploy changes the URL, so Cloudflare's edge cache can't serve old
 *  CSS/JS with new pages. Set once at startup (routes.tsx / main.ts). */
export const assetV: Record<"css" | "js" | "checkout", string> = { css: "", js: "", checkout: "" };
export const asset = (path: string, k: keyof typeof assetV) => (assetV[k] ? `${path}?v=${assetV[k]}` : path);

export interface UiConfig { base: string; rpcUrl: string; network: string; token: string; decimals: number; storeBase: string; tokenContract?: string; accountSuffix?: string }

/** HTML page with the UI stylesheet, the client config and the app script. */
export const UiPage: FC<PropsWithChildren<{ title: string; cfg: UiConfig; page: string; test?: boolean }>> = ({ title, cfg, page, test, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#ffffff" />
      <title>{title}</title>
      <link rel="stylesheet" href={asset("/assets/ui.css", "css")} />
      <script type="application/json" id="nc-config" dangerouslySetInnerHTML={{ __html: JSON.stringify({ ...cfg, page }).replaceAll("<", "\\u003c") }}></script>
      <script type="module" src={asset("/assets/app.js", "js")}></script>
    </head>
    <body>
      {test ? <div class="cap" style="text-align:center;padding:4px;background:#fff3c4;color:#5c4a00">TEST network — payments use free test tokens</div> : null}
      {children}
    </body>
  </html>
);

const NAV = [["home", "Home", "/app"], ["sparkles", "Create", "/app/create"], ["grid", "Posts", "/app/posts"], ["chart", "Analytics", "/app/analytics"], ["wallet", "Wallet", "/app/wallet"], ["sliders", "Settings", "/app/settings"]] as const;

export const Mark: FC<{ s?: number }> = ({ s = 28 }) => <span class="mark" style={`width:${s}px;height:${s}px`}>N</span>;

/** Seller app shell: desktop sidebar, mobile top bar + bottom nav (Figma web app + mobile web rows). */
export const Shell: FC<PropsWithChildren<{ active: string; store: { name: string; account: string; balance?: string } }>> = ({ active, store, children }) => (
  <div class="app">
    <aside class="side">
      <a class="logo" href="/app"><Mark />Nearchant</a>
      <nav class="nav">{NAV.map(([ic, label, href]) => <a href={href} class={label === active ? "on" : ""}><Icon n={ic} />{label}</a>)}</nav>
      <div class="grow"></div>
      <div class="wallet-mini">
        <span class="foot muted">{store.account}</span>
        <span class="t4">{store.balance ?? "—"}</span>
        <Badge label="Store verified on NEAR" />
      </div>
      <div class="sub" style="padding:12px 0 0 6px">{store.name}</div>
    </aside>
    <header class="topbar"><a class="logo" style="padding:0" href="/app"><Mark />Nearchant</a><span class="foot muted">{store.account}</span></header>
    <main class="main">{children}</main>
    <nav class="bottomnav">
      {(["Home", "Posts", "Create", "Analytics", "Wallet"] as const).map((l) => NAV.find(([, x]) => x === l)!).map(([ic, label, href]) => label === "Create"
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
    <>{i ? <span class="csteps-line"></span> : null}<span class={`csteps-s ${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}`}><i>{i + 1 < step ? "✓" : i + 1}</i>{t}</span></>
  ))}</div>
);
