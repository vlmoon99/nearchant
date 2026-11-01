// Page routes of the seller app (ADR 0018). JSON lives in seller-app.ts; these render the Figma screens.
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { PLAN_LIMITS, type ContentStore } from "@nearchant/db";
import { OnboardingPage } from "./onboarding.js";
import { CreatePage, HomePage, PostPage, PostsPage, SignInPage, checklistFor, type StoreView } from "./app-pages.js";
import { createHash } from "node:crypto";
import { UiPage, assetV, type UiConfig } from "./kit.js";
import { AnalyticsPage, Celebration, ReportPage, SettingsPage, WalletPage, type Insights } from "./more-pages.js";
import { readSession } from "../seller-app.js";

export interface UiDeps {
  cfg: UiConfig; test: boolean; css: string; js: string | undefined; sessionKey: Buffer;
  content?: ContentStore;
  accountOf: (handle: string) => string;
  explorer: (accountId: string) => string;
  orders?: (handle: string) => Promise<{ orderId: string; serviceId: string; amount: string; brief: string; state: string; createdAt: string }[]>;
  /** Chain views for the wallet: nUSD balance + prepaid AI billing (null when the chain is unreachable). */
  balances?: (accountId: string) => Promise<{ wallet: string; billing: { balance: string; spent_month: string } | null } | null>;
}

export function mountUi(app: Hono<any>, d: UiDeps): void {
  assetV.css = createHash("sha256").update(d.css).digest("hex").slice(0, 10);
  if (d.js) assetV.js = createHash("sha256").update(d.js).digest("hex").slice(0, 10);
  app.get("/assets/ui.css", (c) => c.body(d.css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/app.js", (c) => (d.js ? c.body(d.js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }) : c.text("app.js not built", 503)));
  app.get("/start", (c) => c.html(<OnboardingPage cfg={d.cfg} test={d.test} />));
  const content = d.content;
  if (!content) return;

  /** Loads the signed-in store or answers with the sign-in page / onboarding. */
  const withStore = async (c: Context, fn: (s: StoreView, img: (id: string | null) => string | null) => Promise<Response>) => {
    const handle = readSession(d.sessionKey, getCookie(c, "nc_session"));
    if (!handle) return c.html(<SignInPage cfg={d.cfg} test={d.test} />);
    const b = await content.getBusiness(handle);
    if (!b) return c.redirect("/start", 302);
    const media = new Map((await content.listMedia(handle)).map((m) => [m.id, m.key]));
    const img = (id: string | null) => (id && media.get(id) ? `/files/${media.get(id)}` : null);
    const account = d.accountOf(handle);
    // Sidebar balance: best effort, never slows a page by more than 1.5 s.
    const bal = d.balances ? await Promise.race([d.balances(account).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]) : null;
    const balance = bal ? `${(Number(bal.wallet) / 10 ** d.cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${d.cfg.token}` : undefined;
    return fn({ handle, name: b.name, account, ...(balance ? { balance } : {}) }, img);
  };

  app.get("/app", (c) => withStore(c, async (s, img) => {
    const [posts, opps, events, usage, b] = await Promise.all([content.listPosts(s.handle, { limit: 50 }), content.listOpportunities(s.handle), content.eventCounts(s.handle, 7), content.usage(s.handle), content.getBusiness(s.handle)]);
    const sum = (k: string) => events.filter((e) => e.kind === k).reduce((a, e) => a + e.n, 0);
    const shown = posts.filter((p) => p.status !== "failed" && (p.chosenAt || p.status !== "ready"));
    const items = await content.listItems(s.handle);
    const prof = (await content.getProfile(s.handle))?.data as { products?: { name: string; photo: number | null; description: string }[] } | undefined;
    const photos = (await content.listMedia(s.handle, "photo")).slice(0, 8);
    const taken = new Set(items.map((i) => i.title.toLowerCase()));
    const suggestions = (prof?.products ?? []).filter((p) => !taken.has(p.name.toLowerCase())).slice(0, 6).map((p) => {
      const m = p.photo ? photos[p.photo - 1] : undefined;
      return { title: p.name, description: p.description, photoMediaId: m?.id ?? null, img: m ? `/files/${m.key}` : null };
    });
    const fmt = (u: string) => `${(Number(u) / 10 ** d.cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${d.cfg.token}`;
    const titles = new Map(items.map((i) => [i.id, i.title]));
    const orders = d.orders ? (await d.orders(s.handle)).filter((o) => o.serviceId.startsWith("i-") && ["paid", "in_progress", "delivered"].includes(o.state)).map((o) => ({ orderId: o.orderId, title: titles.get(o.serviceId) ?? "Item", amount: fmt(o.amount), brief: o.brief, state: o.state })) : [];
    const firstSale = d.orders ? (await d.orders(s.handle)).filter((o) => o.serviceId.startsWith("i-") && o.state !== "awaiting_payment").at(-1) : undefined;
    // 7-day bars (oldest → today), scaled to the busiest day; payments: the latest paid item orders.
    const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
    const bars = (xs: number[]) => { const mx = Math.max(...xs, 1); return xs.map((x) => Math.round((x / mx) * 100)); };
    const perDay = (k: string) => days.map((day) => events.filter((e) => e.kind === k && e.day === day).reduce((a, e) => a + e.n, 0));
    const proofDays = days.map((day) => posts.filter((p) => p.proof && p.publishedAt && p.publishedAt.toISOString().slice(0, 10) === day).length);
    const series = { views: bars(perDay("view")), sales: bars(perDay("sale")), proofs: bars(proofDays) };
    const STATE: Record<string, string> = { paid: "in escrow", in_progress: "in escrow", delivered: "shipped · in escrow", released: "paid out" };
    const payments = d.orders ? (await d.orders(s.handle)).filter((o) => o.serviceId.startsWith("i-") && STATE[o.state]).slice(0, 3)
      .map((o) => ({ title: titles.get(o.serviceId) ?? "Item", amount: fmt(o.amount), when: new Date(o.createdAt).toLocaleDateString("en", { day: "numeric", month: "short" }), state: STATE[o.state]! })) : [];
    return c.html(<HomePage cfg={d.cfg} test={d.test} store={s} posts={shown} img={img} opps={opps} suggestions={suggestions} orders={orders} payments={payments} series={series} items={items.map((i) => ({ title: i.title, price: fmt(i.priceUnits) }))}
      top={firstSale && !(await content.getSetting(`celebrated:${s.handle}`)) ? <Celebration amount={fmt(firstSale.amount)} item={titles.get(firstSale.serviceId) ?? "an item"} store={s} /> : null}
      stats={{ views: sum("view"), sales: sum("sale"), salesUnits: Number((await content.salesSince(s.handle, 7)).units), proofs: posts.filter((p) => p.proof).length, postsMonth: usage.posts, postsLimit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }}
      checklist={checklistFor(b, posts, sum("sale"))} />);
  }));
  app.get("/app/create", (c) => withStore(c, async (s) => {
    const [photos, opps, usage, b] = await Promise.all([content.listMedia(s.handle, "photo"), content.listOpportunities(s.handle), content.usage(s.handle), content.getBusiness(s.handle)]);
    return c.html(<CreatePage cfg={d.cfg} test={d.test} store={s} photos={photos} opps={opps} usage={{ posts: usage.posts, limit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }} />);
  }));
  // The NEAR wallet sends the owner back here with the signed message (MyNearWallet sign-message redirect).
  app.get("/app/wallet-connect", (c) => c.html(<UiPage title="NEAR wallet · Nearchant" cfg={d.cfg} page="wallet-connect" test={d.test}>
    <section class="onb"><span class="logo" style="padding:0"><span class="mark">N</span>Nearchant</span><h1 class="t2">Checking your wallet…</h1><p class="sub muted" id="wallet-msg">One moment.</p><a class="btn secondary" href="/app">Back to Nearchant</a></section>
  </UiPage>));
  app.get("/app/posts", (c) => withStore(c, async (s, img) => {
    const f = ["ready", "scheduled", "published"].includes(c.req.query("f") ?? "") ? c.req.query("f")! : "all";
    return c.html(<PostsPage cfg={d.cfg} test={d.test} store={s} posts={(await content.listPosts(s.handle, { limit: 100 })).filter((p) => p.status !== "failed")} img={img} filter={f} {...(c.req.query("batch") ? { batch: c.req.query("batch")! } : {})} />);
  }));
  app.get("/app/posts/:id", (c) => withStore(c, async (s, img) => {
    const p = await content.getPost(c.req.param("id"));
    if (!p || p.handle !== s.handle) return c.notFound();
    return c.html(<PostPage cfg={d.cfg} test={d.test} store={s} p={p} img={img} explorer={d.explorer(s.account)} />);
  }));

  const fmtU = (u: string | bigint) => `${(Number(u) / 10 ** d.cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${d.cfg.token}`;

  app.get("/app/analytics", (c) => withStore(c, async (s) => {
    const range = [7, 30, 90].includes(Number(c.req.query("d"))) ? Number(c.req.query("d")) : 30;
    const [events, sales, posts, insights] = await Promise.all([content.eventCounts(s.handle, range), content.salesSince(s.handle, range), content.listPosts(s.handle, { limit: 200 }), content.getSetting<Insights>(`insights:${s.handle}`)]);
    const daysN = Math.min(range, 30), days = [];
    for (let i = daysN - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ day, views: events.filter((e) => e.day === day && e.kind === "view").reduce((a, e) => a + e.n, 0), sales: events.filter((e) => e.day === day && e.kind === "sale").reduce((a, e) => a + e.n, 0) });
    }
    const since = Date.now() - range * 86_400_000;
    const published = posts.filter((p) => p.publishedAt && p.publishedAt.getTime() > since);
    const sources = await content.viewSources(s.handle, range);
    return c.html(<AnalyticsPage cfg={d.cfg} test={d.test} store={s} range={range} days={days} sources={sources} insights={insights}
      totals={{ views: events.filter((e) => e.kind === "view").reduce((a, e) => a + e.n, 0), sales: sales.count, revenue: fmtU(sales.units), posts: published.length, proofs: published.filter((p) => p.proof).length }} />);
  }));

  app.get("/app/wallet", (c) => withStore(c, async (s) => {
    const [bal, orders, items] = await Promise.all([d.balances ? d.balances(s.account).catch(() => null) : null, d.orders ? d.orders(s.handle) : [], content.listItems(s.handle, false)]);
    const titles = new Map(items.map((i) => [i.id, i.title]));
    const held = orders.filter((o) => ["paid", "in_progress", "delivered"].includes(o.state));
    const rows = orders.filter((o) => o.state !== "awaiting_payment").slice(0, 20).map((o) => ({ when: o.createdAt.slice(0, 16).replace("T", " "), what: titles.get(o.serviceId) ?? "Order", state: o.state === "released" ? "paid out" : o.state === "delivered" ? "shipped, in escrow" : o.state === "refunded" ? "refunded" : "in escrow", amount: fmtU(o.amount), sign: o.state === "refunded" ? "" : "+" }));
    return c.html(<WalletPage cfg={d.cfg} test={d.test} store={s} balance={bal ? fmtU(bal.wallet) : "—"} escrow={fmtU(held.reduce((a, o) => a + BigInt(o.amount), 0n))} escrowCount={held.length}
      aiMonth={fmtU(bal?.billing?.spent_month ?? "0")} aiBalance={bal?.billing ? fmtU(bal.billing.balance) : "none yet"} rows={rows} explorer={d.explorer(s.account)} />);
  }));

  app.get("/app/settings", (c) => withStore(c, async (s) => {
    const [b, prof, usage] = await Promise.all([content.getBusiness(s.handle), content.getProfile(s.handle), content.usage(s.handle)]);
    const data = (prof?.data ?? {}) as { tone?: string; brand_colors?: string[]; wishes?: string };
    return c.html(<SettingsPage cfg={d.cfg} test={d.test} store={s} b={{ name: b!.name, kind: b!.kind, description: b!.description, links: (b!.links as string[]) ?? [] }}
      tone={data.tone ?? ""} colors={data.brand_colors ?? []} wishes={data.wishes ?? ""} usage={{ posts: usage.posts, limit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }} wallet={await content.getSetting<string>(`walletOf:${s.handle}`)} />);
  }));

  app.get("/app/report", (c) => withStore(c, async (s) => {
    const [sales, total, events, posts, opps] = await Promise.all([content.salesSince(s.handle, 7), content.salesSince(s.handle, 3650), content.eventCounts(s.handle, 7), content.listPosts(s.handle, { limit: 200 }), content.listOpportunities(s.handle)]);
    const weekPosts = posts.filter((p) => p.publishedAt && p.publishedAt.getTime() > Date.now() - 7 * 86_400_000).length;
    return c.html(<ReportPage cfg={d.cfg} test={d.test} store={s} earned={fmtU(sales.units)} sales={sales.count} posts={weekPosts}
      views={events.filter((e) => e.kind === "view").reduce((a, e) => a + e.n, 0)}
      badges={[["star", "First sale", total.count > 0], ["shield", "Verified seller", posts.some((p) => p.proof)], ["calendar", "3 posts in a week", weekPosts >= 3], ["chart", `10 sales · ${Math.min(total.count, 10)}/10`, total.count >= 10]]}
      next={opps.slice(0, 3).map((o) => o.title).concat(opps.length ? [] : ["Post 3 times this week — consistency grows reach"])} />);
  }));
}
