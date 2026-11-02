// Step 12 pages (Figma web app + mobile web rows): Analytics, Wallet, Settings, weekly report, first-sale celebration.
import type { FC } from "hono/jsx";
import { Badge, Icon, PageHead, Shell, Stat, UiPage, type UiConfig } from "./kit.js";
import type { StoreView } from "./app-pages.js";

export interface Insight { text: string; action: string; kind: string }
export interface Insights { insights: Insight[]; best_time: string | null; headline: string; at?: string }
export interface DayRow { day: string; views: number; sales: number }

const Page: FC<{ cfg: UiConfig; test: boolean; title: string; active: string; store: StoreView; children?: unknown }> = ({ cfg, test, title, active, store, children }) => (
  <UiPage title={`${title} · ${store.name}`} cfg={cfg} page="app" test={test}><Shell active={active} store={store}>{children as never}</Shell></UiPage>
);

const Bars: FC<{ days: DayRow[] }> = ({ days }) => {
  const max = Math.max(1, ...days.map((d) => d.views));
  return (
    <div class="row" style="gap:6px;align-items:flex-end;height:160px">
      {days.map((d) => (
        <div class="stack" style="flex:1;gap:4px;align-items:center;justify-content:flex-end;height:100%" title={`${d.day}: ${d.views} views, ${d.sales} sales`}>
          <div class="row" style="gap:2px;align-items:flex-end;height:130px;width:100%;justify-content:center">
            <i style={`display:block;width:45%;max-width:14px;border-radius:4px;background:var(--accent);height:${Math.max(2, (d.views / max) * 100)}%`}></i>
            <i style={`display:block;width:45%;max-width:14px;border-radius:4px;background:var(--ok);height:${d.sales ? Math.max(6, (d.sales / max) * 100) : 0}%`}></i>
          </div>
          <span class="cap muted">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
};

export interface TopPost { id: string; caption: string; img: string | null; when: string; views: number; proofId: string | null; likes?: number; removed?: string | null }
const HEAT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], HEAT_SLOTS = [9, 12, 15, 18, 21, 24];
/** Best-time heatmap (Figma Analytics): rows Mon..Sun, columns 3-hour slots ending at 9, 12, …, 24. */
const Heat: FC<{ heat: number[][] }> = ({ heat }) => {
  const max = Math.max(1, ...heat.flat());
  let best = [0, 0]; heat.forEach((r, d) => r.forEach((n, s) => { if (n > heat[best[0]!]![best[1]!]!) best = [d, s]; }));
  return (<div class="stack" style="gap:6px">
    {heat.map((r, d) => <div class="row" style="gap:4px;align-items:center"><span class="cap muted" style="width:30px">{HEAT_DAYS[d]}</span>
      {r.map((n) => <span style={`flex:1;height:18px;border-radius:5px;background:rgba(0,122,255,${0.08 + 0.85 * (n / max)})`} title={`${n} visits`}></span>)}</div>)}
    <div class="row" style="gap:4px"><span style="width:30px"></span>{HEAT_SLOTS.map((h) => <span class="cap muted" style="flex:1;text-align:center">{h}</span>)}</div>
    <span class="foot">{heat.flat().some((n) => n) ? <>Best: <b>{HEAT_DAYS[best[0]!]} {HEAT_SLOTS[best[1]!]! - 3}:00–{HEAT_SLOTS[best[1]!]}:00</b> (New York time, from your store visits)</> : "No visits yet — the map fills in as people open your store."}</span>
  </div>);
};

export const AnalyticsPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; range: number; totals: { views: number; sales: number; revenue: string; posts: number; proofs: number }; days: DayRow[]; sources: [string, number][]; insights: Insights | null; topPosts?: TopPost[]; heat?: number[][] }> = ({ cfg, test, store, range, totals, topPosts = [], heat, days, sources, insights }) => (
  <Page cfg={cfg} test={test} title="Analytics" active="Analytics" store={store}>
    <PageHead kicker={`Last ${range} days`} title="Analytics">
      {[7, 30, 90].map((r) => <a class={`chip ${r === range ? "on" : ""}`} href={`/app/analytics?d=${r}`}>{r} days</a>)}
    </PageHead>
    <div class="grid4">
      <Stat label="Store views" value={String(totals.views)} />
      <Stat label="Sales" value={totals.revenue} delta={`${totals.sales} order${totals.sales === 1 ? "" : "s"}`} />
      <Stat label="Posts published" value={String(totals.posts)} />
      <Stat label="Proofs on NEAR" value={String(totals.proofs)} delta={totals.proofs ? "all verified" : undefined} />
    </div>
    <div class="cols">
      <div class="card"><div class="spread"><span class="headline">Views and sales by day</span><span class="foot"><span style="color:var(--accent)">●</span> views <span style="color:var(--ok)">●</span> sales</span></div>
        {days.some((d) => d.views || d.sales) ? <Bars days={days} /> : <p class="sub muted">No visits yet. Share your store link — the first visitors start the chart.</p>}
        {sources.length ? <div class="row" style="gap:8px;flex-wrap:wrap">{sources.map(([s, n]) => <span class="tag">{s} · {n}</span>)}</div> : null}
      </div>
      <div class="card"><div class="spread"><div class="row" style="align-items:center;gap:8px"><Icon n="sparkles" c="#AF52DE" /><span class="headline">What AI noticed</span></div><button class="chip" id="refresh-insights">Refresh</button></div>
        {insights ? <>
          <span class="sub b">{insights.headline}</span>
          {insights.insights.map((i) => <div class="card white" style="gap:4px;padding:12px;border:0"><span class="foot">{i.text}</span><span class="foot b" style="color:var(--accent)">{i.action} →</span></div>)}
          {insights.best_time ? <span class="foot muted">Best time to post: <b>{insights.best_time}</b></span> : null}
        </> : <span class="foot muted" data-auto-insights>AI is reading your numbers for the first time…</span>}
        <output class="foot" id="insights-out"></output>
      </div>
    </div>
    <div class="cols">
      <div class="card"><div class="spread"><span class="headline">Top posts</span><a class="foot" href="/app/posts?f=published">All posts</a></div>
        {topPosts.length ? topPosts.map((t) => <a class="row card white" style="flex-direction:row;gap:12px;align-items:center;padding:10px 12px;border:0;color:inherit" href={`/app/posts/${t.id}`}>
          <span style={`width:40px;height:40px;border-radius:8px;flex:none;background:var(--grouped) center/cover${t.img ? ` url('${t.img}')` : ""}`}></span>
          <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="foot b clamp1">{t.caption}</span><span class="cap muted">{t.when} · {t.views} view{t.views === 1 ? "" : "s"} from its link{t.likes ? ` · ♥ ${t.likes}` : ""}{t.removed ? " · removed by moderation" : ""}</span></span>
          {t.proofId ? <span class="badge"><Icon n="shield" s={13} />Proof #{t.proofId}</span> : <span class="cap muted">no proof yet</span>}</a>)
          : <span class="foot muted">Published posts show up here with their views and proof on NEAR.</span>}
      </div>
      <div class="card"><span class="headline">Best time to post</span>{heat ? <Heat heat={heat} /> : null}</div>
    </div>
  </Page>
);

export const WalletPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; balance: string; escrow: string; escrowCount: number; aiMonth: string; aiBalance: string; rows: { when: string; what: string; state: string; amount: string; sign: string }[]; explorer: string; withdrawTo?: string | null }> = ({ cfg, test, store, balance, escrow, escrowCount, aiMonth, aiBalance, rows, explorer, withdrawTo }) => (
  <Page cfg={cfg} test={test} title="Wallet" active="Wallet" store={store}>
    <PageHead kicker={`${store.account} · NEAR account`} title="Wallet">
      <a class="btn secondary hide-m" href={explorer} target="_blank" rel="noopener"><Icon n="globe" />Explorer</a>
      <button class="btn secondary" data-receive={store.account}><Icon n="arrow" />Receive</button>
      <button class="btn" data-withdraw-open><Icon n="send" />Withdraw</button></PageHead>
    <div class="card hidden" id="receive-card"><span class="headline">Receive</span><span class="foot">Send {cfg.token} on NEAR to your store account:</span>
      <div class="spread"><b style="word-break:break-all">{store.account}</b><button class="btn secondary" data-copy={store.account}><Icon n="copy" />Copy</button></div></div>
    <form class="card hidden" id="withdraw-form"><span class="headline">Withdraw {cfg.token}</span>
      <span class="foot muted">Sends from your store account to any NEAR account, signed in this browser with your store key. If the account never held {cfg.token}, the store pays its one-time registration (0.00125 NEAR).</span>
      <label class="field">To NEAR account<input class="input" name="to" required placeholder="you.testnet" value={withdrawTo ?? ""} autocomplete="off" /></label>
      <label class="field">Amount ({cfg.token})<input class="input" name="amount" required inputmode="decimal" placeholder="10" /></label>
      <button class="btn" type="submit"><Icon n="send" />Send</button><output class="foot" id="withdraw-out"></output></form>
    <div class="grid3">
      <div class="card dark" style="gap:8px"><span class="foot">Available balance</span><span class="t1" style="font-size:40px">{balance}</span><span class="tag" style="background:var(--near);color:var(--near-ink)">{store.account}</span><span class="cap">Your own NEAR account — Nearchant can’t move your money.</span></div>
      <div class="stat"><span class="foot muted">Held in escrow</span><span class="metric">{escrow}</span><span class="foot muted">{escrowCount} order{escrowCount === 1 ? "" : "s"} wait for the buyer to confirm</span></div>
      <div class="stat"><span class="foot muted">AI usage this month</span><span class="metric">{aiMonth}</span><span class="foot muted">Prepaid AI balance: {aiBalance} · settled on NEAR</span></div>
    </div>
    <div class="cols">
      <div class="card"><span class="headline">Transactions</span>
        {rows.length ? rows.map((r) => <div class="spread card white" style="padding:10px 12px;border:0;flex-direction:row"><span class="stack" style="gap:2px"><span class="foot b">{r.what}</span><span class="cap proof-t">{r.when} · {r.state} · on NEAR</span></span><span class={`sub b ${r.sign === "+" ? "okt" : ""}`} style="white-space:nowrap">{r.sign}{r.amount}</span></div>) : <span class="foot muted">No payments yet.</span>}
      </div>
      <div class="card"><span class="headline">How you get paid</span>
        {[["lock", "Buyer pays in USDC on NEAR", "Money goes into escrow, not to a middleman."], ["check", "You ship, the buyer confirms", "Or it confirms itself after the timeout."], ["wallet", "Released to you automatically", `Straight to ${store.account}.`]].map(([ic, t, d]) => <div class="row" style="gap:12px"><span class="dot" style="background:var(--bg);border-radius:10px;width:32px;height:32px"><Icon n={ic!} s={16} c="#007AFF" /></span><span class="stack" style="gap:2px"><span class="foot b">{t}</span><span class="foot muted">{d}</span></span></div>)}
      </div>
    </div>
  </Page>
);

export const SettingsPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; b: { name: string; kind: string; description: string; links: string[]; city?: string | null; country?: string | null; ships?: string | null; placeBy?: string | null }; tone: string; colors: string[]; wishes: string; usage: { posts: number; limit: number }; wallet?: string | null; plan: string; created: string; telegramBot?: string | null; email?: string | null; emailOn?: boolean }> = ({ cfg, test, store, b, tone, colors, wishes, usage, wallet, plan, created, telegramBot, email, emailOn }) => (
  <Page cfg={cfg} test={test} title="Settings" active="Settings" store={store}>
    <PageHead kicker={store.name} title="Settings" />
    <div class="cols">
      <div class="stack">
        <form class="card" id="settings-store"><span class="headline">Store profile</span>
          <label class="field">Store name<input class="input" name="name" value={b.name} maxlength={80} /></label>
          <label class="field">What you sell<textarea class="input" name="description" maxlength={600}>{b.description}</textarea></label>
          <label class="field">Link<input class="input" name="link" value={b.links[0] ?? ""} /></label>
          <input type="hidden" name="kind" value={b.kind} />
          <button class="btn" type="submit">Save</button><output class="foot"></output>
        </form>
        <form class="card" id="settings-place"><span class="headline">Where you sell</span>
          <span class="foot muted">Buyers who search the shop feed for your city — or for places you ship to — find your posts.{b.placeBy === "ai" ? " AI filled this in from your description; check it." : ""}</span>
          <div class="row" style="gap:10px;flex-wrap:wrap"><label class="field" style="flex:2 1 160px">City<input class="input" name="city" value={b.city ?? ""} maxlength={60} placeholder="New York" /></label>
            <label class="field" style="flex:1 1 90px">Country<input class="input" name="country" value={b.country ?? ""} maxlength={2} placeholder="US" style="text-transform:uppercase" /></label></div>
          <label class="field">You deliver<select class="input" name="ships">{[["", "—"], ["local", "In my city only"], ["country", "Across my country"], ["world", "Worldwide"]].map(([v, l]) => <option value={v} selected={(b.ships ?? "") === v}>{l}</option>)}</select></label>
          <button class="btn" type="submit">Save</button><output class="foot"></output>
        </form>
        <form class="card" id="settings-brand"><span class="headline">Brand — AI writes like you</span>
          <span class="foot muted">Tone AI found: <b>{tone || "—"}</b></span>
          {colors.length ? <div class="row" style="gap:8px">{colors.map((c) => <span style={`width:24px;height:24px;border-radius:999px;border:1px solid var(--sep);background:${c}`}></span>)}</div> : null}
          <label class="field">Your wishes for posts and pictures<textarea class="input" name="wishes" maxlength={500} placeholder="e.g. show the clothes on a person, outdoors, warm light; no discounts">{wishes}</textarea></label>
          <button class="btn" type="submit">Save</button><output class="foot"></output>
        </form>
        <div class="card" style="gap:10px"><span class="headline">Where posts go</span>
          {[["store", "Store page", `Live · nearchant.com/h/${store.handle}`, true, "Open", `/h/${store.handle}/`],
            ["send", "Telegram bot", telegramBot ? `Connected · @${telegramBot} · takes orders in chat` : "Not connected — your own bot takes orders in chat", !!telegramBot, telegramBot ? "Settings" : "Connect", `/h/${store.handle}/manage`],
            ["camera", "Instagram", "Copy a ready post with its picture from the post page", false, "Posts", "/app/posts"]].map(([ic, t, d, on, act, href]) =>
            <div class="card white" style="flex-direction:row;gap:12px;align-items:center;padding:12px 14px">
              <span class="dot" style="background:var(--bg);border-radius:10px;width:36px;height:36px;flex:none"><Icon n={ic as string} s={18} c="#1d1d1f" /></span>
              <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="callout b">{t}</span><span class="foot" style={on ? "color:#248a3d" : "color:var(--label2)"}>{d}</span></span>
              <a class="sub" style="color:#007AFF" href={href as string}>{act}</a>
            </div>)}
        </div>
      </div>
      <div class="stack">
        <div class="card dark" style="gap:10px"><div class="row" style="align-items:center;gap:8px"><span class="mark" style="background:var(--near);color:var(--near-ink)">N</span><span class="headline">NEAR account</span></div>
          <span class="t2" style="color:var(--near);overflow-wrap:anywhere">{store.account}</span><span class="foot">Created for you — no seed phrase. Posts, proofs and payments live here.</span>
          <div class="spread foot"><span>Agent keys</span><b>limited keys · can’t move money</b></div>
          <div class="spread foot"><span>Created</span><b>{created}</b></div>
          <a class="btn secondary" id="export-key" href="#" style="color:var(--label)"><Icon n="copy" />Export my key</a><Badge label="Store verified on NEAR" /></div>
        <div class="card" id="wallet"><span class="headline">NEAR wallet</span>
          {wallet ? <span class="foot">Linked: <b>{wallet}</b> — you can sign in with it from any browser.</span>
            : <span class="foot muted">Link your own NEAR wallet (MyNearWallet) to sign in from any browser. It signs a one-time message: no transaction, no fee.</span>}
          <button class="btn near" data-wallet="link"><Icon n="wallet" />{wallet ? "Link another wallet" : "Connect a NEAR wallet"}</button>
          <output class="foot" id="wallet-out"></output></div>
        {emailOn ? <form class="card" id="email" data-email-link><span class="headline">Email</span>
          {email ? <span class="foot">Linked: <b>{email}</b> — sign in from any browser with a link we email you. New orders are emailed here.</span>
            : <span class="foot muted">Add your email to sign in from any browser with a one-time link, and to hear about new orders.</span>}
          <input class="input" type="email" name="email" required placeholder="you@example.com" autocomplete="email" />
          <button class="btn secondary" type="submit"><Icon n="send" />{email ? "Change email" : "Send confirmation link"}</button>
          <output class="foot"></output></form> : null}
        <div class="card"><span class="headline">Plan</span><div class="spread"><span class="foot">{plan === "pro" ? "Pro" : "Free"} · {usage.posts} of {usage.limit} posts this month</span></div>
          <div class="progress"><i style={`width:${Math.min(100, (usage.posts / usage.limit) * 100)}%`}></i></div>
          <span class="foot muted">{plan === "pro" ? "You are on Pro." : "Pro — 150 posts a month, paid from your balance on NEAR (coming soon)."}</span></div>
        <div class="card" style="gap:10px"><span class="headline">Your data</span>
          <a class="spread sub" href="/api/app/export" download style="color:inherit">Download all my data<Icon n="download" s={18} c="#007AFF" /></a>
          <span class="cap muted">Records already on NEAR stay public (they hold hashes, not your photos or texts).</span></div>
      </div>
    </div>
  </Page>
);

export const ReportPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; earned: string; sales: number; views: number; posts: number; badges: [string, string, boolean][]; next: string[] }> = ({ cfg, test, store, earned, sales, views, posts, badges, next }) => (
  <Page cfg={cfg} test={test} title="Your week" active="Analytics" store={store}>
    <PageHead kicker="Weekly report · last 7 days" title={sales ? "Great week 👏" : "Your week"} />
    <div class="card dark" style="gap:6px"><span class="foot">You earned</span><span class="t1" style="color:var(--near)">{earned}</span><span class="foot">{sales} sale{sales === 1 ? "" : "s"} · all paid on NEAR</span></div>
    <div class="grid3"><Stat label="Store views" value={String(views)} /><Stat label="Posts published" value={String(posts)} /><Stat label="Sales" value={String(sales)} /></div>
    <div class="card"><span class="headline">Badges</span><div class="row" style="gap:10px;flex-wrap:wrap">{badges.map(([ic, l, on]) => <span class="card white" style={`gap:6px;padding:12px 16px;align-items:center;${on ? "" : "opacity:.45"}`}><Icon n={ic} s={22} c={on ? "#FF9500" : "#8E8E93"} /><span class="cap b">{l}</span></span>)}</div></div>
    <div class="card soft"><div class="row" style="align-items:center;gap:8px"><Icon n="sparkles" c="#AF52DE" /><span class="headline">For next week</span></div>{next.map((n) => <span class="foot">• {n}</span>)}<a class="btn" href="/app/create">Plan next week’s posts</a></div>
  </Page>
);

/** First-sale celebration on Home (Figma onboarding 9): shown once, dismissed by the owner. */
export const Celebration: FC<{ amount: string; item: string; store: StoreView }> = ({ amount, item, store }) => (
  <div class="card" id="celebration" style="align-items:center;text-align:center;gap:10px;background:linear-gradient(135deg,#e6f1ff,#e3faf0)">
    <div class="confetti" style="width:100%">{Array.from({ length: 18 }, (_, k) => <i style={`left:${(k * 53) % 96}%;top:${(k * 37) % 70}px;transform:rotate(${(k * 47) % 90 - 45}deg);background:${["#007AFF", "#FF9500", "#34C759", "#FF2D55", "#AF52DE", "#00EC97"][k % 6]}`}></i>)}</div>
    <h2 class="tl">Your first sale! 🎉</h2>
    <span class="sub muted">Someone bought <b>{item}</b>.</span>
    <span class="t1 okt" style="font-size:40px">+{amount}</span>
    <span class="foot muted">Safe in escrow on NEAR — yours as soon as the buyer confirms.</span>
    <div class="row" style="gap:10px;flex-wrap:wrap;justify-content:center"><a class="btn" href={`https://t.me/share/url?url=${encodeURIComponent(`https://nearchant.com/h/${store.handle}/?ref=telegram`)}`} target="_blank" rel="noopener"><Icon n="send" />Share your verified store</a><button class="btn secondary" id="dismiss-celebration">Thanks!</button></div>
  </div>
);
