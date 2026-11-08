// Page routes of the seller app (ADR 0018). JSON lives in seller-app.ts; these render the Figma screens.
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { PLAN_LIMITS, type BuyerContact, type ContentStore } from "@nearchant/db";
import { ItemEditPage, ItemSharePage, ShopPage, ShopSharePage, type ShopItem } from "./shop.js";
import { checkHash, type ItemDetails } from "../item-details.js";
import { OrdersPage, SellerOrderPage, type SellerOrder } from "./orders.js";
import { OnboardingPage } from "./onboarding.js";
import { CreatePage, HomePage, PostPage, PostsPage, SignInPage, checklistFor, type StoreView } from "./app-pages.js";
import { createHash } from "node:crypto";
import { BuyerLinks, BuyerTabs, Mark, UiPage, assetV, type UiConfig } from "./kit.js";
import { ExplorePage, FeedTiles, type FeedTile } from "./explore.js";
import { feedFor, searchSource, type SearchIntent } from "../buyer-app.js";
import { clientIp } from "../buyers.js";
import type { FeedPost, FeedStore } from "@nearchant/db";
import { AnalyticsPage, Celebration, ReportPage, SettingsPage, WalletPage, type Insights } from "./more-pages.js";
import { readSession } from "../seller-app.js";
import { VerifyPage, type VerifyView } from "./verify.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A proof-log entry as the contract returns it. */
export interface ProofEntry { proof_id: string; task_id: string; author_id: string; output_hash: string; producer: string; attestation_ref: string | null; review: { passed: boolean } | null; created_at: string }

export interface UiDeps {
  /** proofs.get on NEAR (null = no such proof). */
  proof?: (id: string) => Promise<ProofEntry | null>;
  proofsContract?: string;
  mediaDir?: string;
  cfg: UiConfig; test: boolean; css: string; js: string | undefined; sessionKey: Buffer;
  content?: ContentStore;
  /** Email sign-in is set up (ADR 0021). */
  emailOn?: boolean;
  /** Shop feed (ADR 0022). */
  feedStore?: FeedStore;
  understand?: (q: string) => Promise<SearchIntent>;
  buyerKey?: Buffer;
  suggestions?: () => Promise<string[]>;
  buyerJs?: string;
  /** "My orders" of a signed-in buyer (ADR 0022). */
  buyerOrders?: (buyerId: string) => Promise<{ orderId: string; handle: string; store: string; title: string; amount: string; state: string; at: string }[]>;
  walletJs?: string;
  accountOf: (handle: string) => string;
  explorer: (accountId: string) => string;
  orders?: (handle: string) => Promise<{ orderId: string; serviceId: string; amount: string; brief: string; state: string; createdAt: string; updatedAt: string; contact?: BuyerContact | null }[]>;
  /** The order on the orders contract (money state). */
  orderStatus?: (orderId: string) => Promise<{ status: string } | null>;
  /** The Agent Market connection can be set up from Settings. */
  marketOn?: boolean;
  ordersContract?: string;
  /** Chain views for the wallet: nUSD balance + prepaid AI billing (null when the chain is unreachable). */
  balances?: (accountId: string) => Promise<{ wallet: string; billing: { balance: string; spent_month: string } | null } | null>;
}

export function mountUi(app: Hono<any>, d: UiDeps): void {
  assetV.css = createHash("sha256").update(d.css).digest("hex").slice(0, 10);
  if (d.js) assetV.js = createHash("sha256").update(d.js).digest("hex").slice(0, 10);
  for (const [k, body] of [["buyer", d.buyerJs], ["wallet", d.walletJs]] as const) {
    if (!body) continue;
    assetV[k] = createHash("sha256").update(body).digest("hex").slice(0, 10);
    app.get(`/assets/${k}.js`, (c) => c.body(body, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=300" }));
  }
  app.get("/assets/ui.css", (c) => c.body(d.css, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }));
  app.get("/assets/app.js", (c) => (d.js ? c.body(d.js, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }) : c.text("app.js not built", 503)));
  app.get("/start", (c) => c.html(<OnboardingPage cfg={d.cfg} test={d.test} />));
  // Verify a post: the proof from NEAR, the fingerprint recomputed from the published caption + picture file.
  const verify = async (c: Context, id: string | undefined) => {
    const latest = d.content ? (await d.content.showcase(8)).posts.filter((p) => p.proofId).map((p) => ({ id: p.proofId!, store: p.storeName, caption: p.caption })) : [];
    let v: VerifyView | null = null;
    if (id !== undefined && /^\d{1,12}$/.test(id) && d.proof) {
      const e = await d.proof(id).catch(() => null);
      v = { proofId: id, found: !!e, contractUrl: d.explorer(d.proofsContract ?? "proofs.nearchant.testnet") };
      if (e) {
        const created = new Date(Number(BigInt(e.created_at) / 1_000_000n));
        Object.assign(v, { author: e.author_id, producer: e.producer, outputHash: e.output_hash, createdAt: created.toUTCString().replace(" GMT", " UTC"), reviewPassed: e.review ? e.review.passed : null, recomputed: null, match: null });
        const postId = e.task_id.startsWith("post:") ? e.task_id.slice(5) : null;
        const found = postId && d.content ? await d.content.getPost(postId) : null;
        // Anyone can write to proof-log: the post counts only if this proof is the one the store's own account
        // recorded for it (signer = the store account, and the post's recorded proof id = this id).
        const post = found && e.author_id === d.accountOf(found.handle) && (found.proof as { proofId?: string } | null)?.proofId === id ? found : null;
        if (found && !post) v.foreign = true;
        const pub = (post?.idea as { publicImage?: string } | undefined)?.publicImage;
        if (post && pub && d.mediaDir) {
          const bytes = await readFile(join(d.mediaDir, pub)).catch(() => null);
          if (bytes) {
            const h = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
            v.recomputed = h(`${post.caption ?? ""}\n${h(bytes)}`);
            v.match = v.recomputed === e.output_hash;
          }
          const b = await d.content!.getBusiness(post.handle);
          v.post = { caption: post.caption ?? "", img: `/files/${pub}?w=320`, store: b?.name ?? post.handle, href: `/h/${post.handle}/` };
        }
        const a = post ? /^nearai:(.+):([0-9a-f]{64})$/.exec(e.attestation_ref ?? "") : null;
        if (!post) v.reviewPassed = null;
        if (a) {
          const check = d.mediaDir ? await readFile(join(d.mediaDir, "attestations", `${a[2]}.check.json`), "utf8").then((x) => JSON.parse(x) as { ok?: boolean; gateway_tdx_verified?: boolean | null; models?: { gpu_verified?: boolean | null }[] }, () => null) : null;
          const sig = (post?.idea as { writer?: { signature?: { kind: string; verified: boolean; signer?: string; text?: string; signature?: string } } } | undefined)?.writer?.signature;
          if (sig) v.signed = sig;
          v.attestation = { model: a[1]!, hash: a[2]!, ok: check ? check.ok === true : null, gpu: check?.models?.length ? (check.models.every((m) => m.gpu_verified === true) ? true : check.models.some((m) => m.gpu_verified === false) ? false : null) : null };
        }
      }
    }
    return c.html(<VerifyPage cfg={d.cfg} test={d.test} v={v} latest={latest} />);
  };
  // The shop feed (ADR 0022): search by meaning + region, "For you" for signed-in buyers, infinite scroll.
  const tilesOf = (posts: FeedPost[]): FeedTile[] => posts.map((p) => ({ id: p.id, handle: p.handle, caption: p.caption, img: `/files/${p.publicImage}?w=640`,
    video: p.publicVideo ? `/files/${p.publicVideo}` : null, proofId: p.proofId, storeName: p.storeName, place: [p.city, p.country].filter(Boolean).join(", ") || null, likes: p.likes, liked: p.liked, why: p.why }));
  const feedQuery = (c: Context) => ({ q: (c.req.query("q") ?? "").trim().slice(0, 200), city: (c.req.query("city") ?? "").trim().slice(0, 60), offset: Math.max(0, Number(c.req.query("offset") ?? 0) || 0) });
  const nextOf = (q: string, city: string, offset: number, n: number) => (n === 24 ? `/feed?${new URLSearchParams({ ...(q ? { q } : {}), ...(city ? { city } : {}), offset: String(offset + 24) })}` : null);
  app.get("/feed", async (c) => {
    if (!d.feedStore) return c.notFound();
    const { q, city, offset } = feedQuery(c), buyer = d.buyerKey ? readSession(d.buyerKey, getCookie(c, "nc_buyer")) : null;
    const r = await feedFor({ feed: d.feedStore, ...(d.understand ? { understand: d.understand } : {}) }, q, buyer, offset, { city, visitorCountry: process.env.TRUST_PROXY === "cloudflare" ? c.req.header("cf-ipcountry") ?? null : null, ...(d.buyerKey ? { src: searchSource(d.buyerKey, clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress)) } : {}) });
    const stores = r.stores.map((st) => ({ handle: st.handle, name: st.name, place: [st.city, st.country].filter(Boolean).join(", ") || null, img: st.image ? `/files/${st.image}?w=320` : null, goods: st.goods.map((g) => ({ name: g.name, match: g.match })), matched: st.matched, followers: st.followers }));
    return c.html(<ExplorePage cfg={d.cfg} test={d.test} q={q} city={city} summary={r.intent?.summary ?? null} posts={tilesOf(r.posts)} next={nextOf(q, city, offset, r.posts.length)} stores={stores}
      suggestions={d.suggestions ? await d.suggestions().catch(() => []) : []} forYou={!!buyer} />);
  });
  app.get("/feed/more", async (c) => {
    if (!d.feedStore) return c.notFound();
    const { q, city, offset } = feedQuery(c), buyer = d.buyerKey ? readSession(d.buyerKey, getCookie(c, "nc_buyer")) : null;
    const r = await feedFor({ feed: d.feedStore, ...(d.understand ? { understand: d.understand } : {}) }, q, buyer, offset, { city, visitorCountry: process.env.TRUST_PROXY === "cloudflare" ? c.req.header("cf-ipcountry") ?? null : null, ...(d.buyerKey ? { src: searchSource(d.buyerKey, clientIp((n) => c.req.header(n), (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress)) } : {}) });
    return c.html(<FeedTiles posts={tilesOf(r.posts)} next={nextOf(q, city, offset, r.posts.length)} />);
  });
  app.get("/feed/liked", async (c) => {
    if (!d.feedStore) return c.notFound();
    const buyer = d.buyerKey ? readSession(d.buyerKey, getCookie(c, "nc_buyer")) : null;
    const posts = buyer ? await d.feedStore.feed({ buyerId: buyer, onlyLiked: true, limit: 60 }) : [];
    return c.html(<ExplorePage cfg={d.cfg} test={d.test} q="" city="" summary={null} posts={tilesOf(posts)} next={null} suggestions={[]} forYou={!!buyer} liked />);
  });
  app.get("/feed/following", async (c) => {
    if (!d.feedStore) return c.notFound();
    const buyer = d.buyerKey ? readSession(d.buyerKey, getCookie(c, "nc_buyer")) : null;
    const posts = buyer ? await d.feedStore.feed({ buyerId: buyer, onlyFollowing: true, limit: 60 }) : [];
    return c.html(<ExplorePage cfg={d.cfg} test={d.test} q="" city="" summary={null} posts={tilesOf(posts)} next={null} suggestions={[]} forYou={!!buyer} following />);
  });
  app.get("/feed/orders", async (c) => {
    const buyer = d.buyerKey ? readSession(d.buyerKey, getCookie(c, "nc_buyer")) : null;
    const orders = buyer && d.buyerOrders ? await d.buyerOrders(buyer) : [];
    const label: Record<string, string> = { paid: "Paid — in escrow", in_progress: "Being prepared", delivered: "Shipped — confirm when you get it", released: "Done", refunded: "Refunded" };
    return c.html(<UiPage title="My orders · Nearchant" cfg={d.cfg} page="feed" test={d.test} buyer>
      <div class="land"><nav class="land-nav"><a class="land-logo" href="/feed"><Mark />Nearchant</a><BuyerLinks active="orders" /><a class="btn sm secondary" href="/">Sell here</a></nav>
        <section class="stack" style="max-width:760px;margin:0 auto;padding:24px 16px 80px;gap:14px"><h1 class="t2" style="margin:0">My orders</h1>
          {/* Orders paid in this browser (kept by the checkout), also when not signed in — filled by buyer.ts */}
          <div class="stack s12" data-local-orders={JSON.stringify(orders.map((o) => o.orderId))}></div>
          {!buyer ? <div class="card"><span class="headline">See your orders on every device</span><span class="foot muted">Orders you pay in this browser show up here. Sign in to keep them with your account, on any phone or computer.</span><a class="btn" href="#" data-buyer-me>Sign in</a></div>
            : !orders.length ? <div class="card" data-no-orders><span class="headline">No orders yet</span><span class="foot muted">Find something in the <a href="/feed">shop feed</a> — you pay into escrow on NEAR and the store is paid when you confirm.</span></div>
            : orders.map((o) => <a class="card white" href={`/h/${o.handle}/o/${o.orderId}`} style="flex-direction:row;gap:12px;align-items:center;color:inherit">
              <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="callout b">{o.title}</span><span class="foot muted">{o.store} · {o.at.slice(0, 10)}</span></span>
              <span class="stack" style="gap:2px;align-items:flex-end"><span class="sub b">{o.amount}</span><span class="cap" style={o.state === "delivered" ? "color:var(--orange-text)" : "color:var(--label-2)"}>{label[o.state] ?? o.state}</span></span></a>)}
          <span class="cap muted">Money waits in escrow on NEAR until you confirm you got your order. Not delivered in time? You get it back automatically.</span>
        </section><BuyerTabs active="orders" /></div></UiPage>);
  });
  app.get("/explore", (c) => c.redirect(`/feed${new URL(c.req.url).search}`, 301));
  app.get("/verify", (c) => verify(c, c.req.query("id")?.trim() || undefined));
  app.get("/verify/:id", (c) => verify(c, c.req.param("id")));
  const content = d.content;
  if (!content) return;

  /** Loads the signed-in store or answers with the sign-in page / onboarding. */
  const withStore = async (c: Context, fn: (s: StoreView, img: (id: string | null) => string | null) => Promise<Response>) => {
    const handle = readSession(d.sessionKey, getCookie(c, "nc_session"));
    if (!handle) return c.html(<SignInPage cfg={d.cfg} test={d.test} />);
    const b = await content.getBusiness(handle);
    if (!b) return c.redirect("/start", 302);
    const media = new Map((await content.listMedia(handle)).map((m) => [m.id, m.key]));
    const img = (id: string | null) => (id && media.get(id) ? `/files/${media.get(id)}?w=640` : null);
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
  // Orders (store items): what needs the owner, then one order with its actions and the buyer's contact (ADR 0026).
  const sellerOrders = async (handle: string) => {
    if (!d.orders) return [];
    const items = new Map((await content.listItems(handle, false)).map((i) => [i.id, i]));
    const rows = (await d.orders(handle)).filter((o) => o.serviceId.startsWith("i-") && o.state !== "awaiting_payment" && o.state !== "cancelled");
    const chain = await Promise.all(rows.map((o) => ["released", "refunded"].includes(o.state) || !d.orderStatus ? null : d.orderStatus(o.orderId).catch(() => null)));
    const fmt = (u: string) => `${(Number(u) / 10 ** d.cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${d.cfg.token}`;
    return rows.map((o, i): SellerOrder => ({ orderId: o.orderId, title: items.get(o.serviceId)?.title ?? "Item", kind: items.get(o.serviceId)?.kind ?? "product", amount: fmt(o.amount), brief: o.brief, state: o.state,
      chainStatus: chain[i]?.status ?? null, createdAt: o.createdAt, updatedAt: o.updatedAt, contact: o.contact ?? null }));
  };
  app.get("/app/orders", (c) => withStore(c, async (s) => {
    const f = ["done", "all"].includes(c.req.query("f") ?? "") ? c.req.query("f")! : "open";
    return c.html(<OrdersPage cfg={d.cfg} test={d.test} store={s} orders={await sellerOrders(s.handle)} filter={f} />);
  }));
  app.get("/app/orders/:id", (c) => withStore(c, async (s) => {
    const o = (await sellerOrders(s.handle)).find((x) => x.orderId === c.req.param("id"));
    if (!o) return c.redirect("/app/orders");
    return c.html(<SellerOrderPage cfg={d.cfg} test={d.test} store={s} o={o} explorer={d.explorer(d.ordersContract ?? "")} />);
  }));

  // Shop (ADR 0026): products and services — list, add, edit.
  const shopItems = async (handle: string, img: (id: string | null) => string | null): Promise<ShopItem[]> => Promise.all((await content.listItems(handle, false)).map(async (i) => ({
    checking: i.active && (await content.getSetting<{ hash: string }>(`itemMod:${i.id}`))?.hash !== checkHash(i),
    id: i.id, kind: i.kind === "service" ? "service" : "product", title: i.title, description: i.description, photoMediaId: i.photoMediaId, img: img(i.photoMediaId), active: i.active, held: i.held,
    priceNumber: Number(i.priceUnits) / 10 ** d.cfg.decimals, price: `${(Number(i.priceUnits) / 10 ** d.cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${d.cfg.token}`,
    options: (i.options as string[]) ?? [], details: (i.details ?? {}) as ItemDetails,
  })));
  const shopSuggestions = async (handle: string, items: { title: string }[]) => {
    const prof = (await content.getProfile(handle))?.data as { products?: { name: string; photo: number | null; description: string }[] } | undefined;
    const photos = (await content.listMedia(handle, "photo")).slice(0, 8);
    const taken = new Set(items.map((i) => i.title.toLowerCase()));
    return (prof?.products ?? []).filter((p) => !taken.has(p.name.toLowerCase())).slice(0, 8).map((p) => {
      const m = p.photo ? photos[p.photo - 1] : undefined;
      return { title: p.name, description: p.description, photoMediaId: m?.id ?? null, img: m ? `/files/${m.key}?w=320` : null };
    });
  };
  app.get("/app/shop", (c) => withStore(c, async (s, img) => {
    const items = await shopItems(s.handle, img);
    const b = await content.getBusiness(s.handle);
    const k = c.req.query("k");
    const tab = k === "service" || k === "product" ? k : b?.kind === "services" ? "service" : "product";
    return c.html(<ShopPage cfg={d.cfg} test={d.test} store={s} items={items} suggestions={await shopSuggestions(s.handle, items)} tab={tab} />);
  }));
  const photoPicks = async (handle: string) => (await content.listMedia(handle)).filter((m) => m.kind !== "video").reverse().slice(0, 30).map((m) => ({ id: m.id, img: `/files/${m.key}?w=320` }));
  app.get("/app/shop/new", (c) => withStore(c, async (s, img) => {
    const items = await shopItems(s.handle, img);
    const n = Number(c.req.query("suggest"));
    const prefill = Number.isInteger(n) && n >= 0 ? (await shopSuggestions(s.handle, items))[n] ?? null : null;
    return c.html(<ItemEditPage cfg={d.cfg} test={d.test} store={s} item={null} kind={c.req.query("kind") === "service" ? "service" : "product"} photos={await photoPicks(s.handle)} prefill={prefill} />);
  }));
  // Share & sell anywhere (ADR 0027): banners, links and the buy widget.
  const site = d.cfg.storeBase ? `https://${d.cfg.storeBase}` : "";
  app.get("/app/shop/share", (c) => withStore(c, async (s, img) => c.html(<ShopSharePage cfg={d.cfg} test={d.test} store={s} items={await shopItems(s.handle, img)} site={site || new URL(c.req.url).origin} />)));
  app.get("/app/shop/:id/share", (c) => withStore(c, async (s, img) => {
    const item = (await shopItems(s.handle, img)).find((i) => i.id === c.req.param("id"));
    if (!item) return c.redirect("/app/shop");
    return c.html(<ItemSharePage cfg={d.cfg} test={d.test} store={s} item={item} site={site || new URL(c.req.url).origin} />);
  }));
  app.get("/app/shop/:id", (c) => withStore(c, async (s, img) => {
    const item = (await shopItems(s.handle, img)).find((i) => i.id === c.req.param("id"));
    if (!item) return c.redirect("/app/shop");
    return c.html(<ItemEditPage cfg={d.cfg} test={d.test} store={s} item={item} kind={item.kind as "product" | "service"} photos={await photoPicks(s.handle)} />);
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
    const [sources, hours, pv] = await Promise.all([content.viewSources(s.handle, range), content.visitHours(s.handle, range), content.postViews(s.handle, range)]);
    // Heatmap: Mon..Sun × 3-hour slots ending 9..24 (00–06 counts toward the first slot).
    const heat = Array.from({ length: 7 }, () => Array(6).fill(0) as number[]);
    for (const h of hours) heat[(h.dow + 6) % 7]![Math.min(5, Math.max(0, Math.ceil((h.hour + 1) / 3) - 3))]! += h.n;
    const media = new Map((await content.listMedia(s.handle)).map((m) => [m.id, m.key]));
    const likeMap = d.feedStore ? await d.feedStore.likeCounts(published.map((p) => p.id)) : new Map<string, number>();
    const topPosts = published.map((p) => ({ id: p.id, caption: p.caption ?? "", img: p.imageMediaId && media.get(p.imageMediaId) ? `/files/${media.get(p.imageMediaId)}?w=320` : null,
      when: p.publishedAt!.toLocaleDateString("en-US", { month: "short", day: "numeric" }), views: pv.get(p.id) ?? 0, proofId: (p.proof as { proofId?: string } | null)?.proofId ?? null, likes: likeMap.get(p.id) ?? 0, removed: p.removedReason }))
      .sort((a, b) => b.views + b.likes * 3 - (a.views + a.likes * 3)).slice(0, 5);
    const country = (await content.getBusiness(s.handle))?.country ?? null;
    const [demand, found] = d.feedStore ? await Promise.all([d.feedStore.demand({ days: range, country, limit: 10 }), d.feedStore.searchesFor(s.handle, range)]) : [[], null];
    return c.html(<AnalyticsPage cfg={d.cfg} test={d.test} store={s} range={range} days={days} sources={sources} insights={insights} topPosts={topPosts} heat={heat} demand={demand} found={found} country={country} questions={(await content.getSetting<{ q: string; a: string; owner: boolean; at: string }[]>(`questions:${s.handle}`)) ?? []}
      totals={{ views: events.filter((e) => e.kind === "view").reduce((a, e) => a + e.n, 0), sales: sales.count, revenue: fmtU(sales.units), posts: published.length, proofs: published.filter((p) => p.proof).length, likes: [...likeMap.values()].reduce((a, n) => a + n, 0), followers: d.feedStore ? await d.feedStore.followers(s.handle) : 0 }} />);
  }));

  app.get("/app/wallet", (c) => withStore(c, async (s) => {
    const [bal, orders, items] = await Promise.all([d.balances ? d.balances(s.account).catch(() => null) : null, d.orders ? d.orders(s.handle) : [], content.listItems(s.handle, false)]);
    const titles = new Map(items.map((i) => [i.id, i.title]));
    const held = orders.filter((o) => ["paid", "in_progress", "delivered"].includes(o.state));
    const rows = orders.filter((o) => o.state !== "awaiting_payment").slice(0, 20).map((o) => ({ when: o.createdAt.slice(0, 16).replace("T", " "), what: titles.get(o.serviceId) ?? "Order", state: o.state === "released" ? "paid out" : o.state === "delivered" ? "shipped, in escrow" : o.state === "refunded" ? "refunded" : "in escrow", amount: fmtU(o.amount), sign: o.state === "refunded" ? "" : "+" }));
    return c.html(<WalletPage cfg={d.cfg} test={d.test} store={s} balance={bal ? fmtU(bal.wallet) : "—"} escrow={fmtU(held.reduce((a, o) => a + BigInt(o.amount), 0n))} escrowCount={held.length}
      aiMonth={fmtU(bal?.billing?.spent_month ?? "0")} aiBalance={bal?.billing ? fmtU(bal.billing.balance) : "none yet"} rows={rows} explorer={d.explorer(s.account)} withdrawTo={await content.getSetting<string>(`walletOf:${s.handle}`)} />);
  }));

  app.get("/app/settings", (c) => withStore(c, async (s) => {
    const [b, prof, usage] = await Promise.all([content.getBusiness(s.handle), content.getProfile(s.handle), content.usage(s.handle)]);
    const data = (prof?.data ?? {}) as { tone?: string; brand_colors?: string[]; wishes?: string };
    return c.html(<SettingsPage cfg={d.cfg} test={d.test} store={s} b={{ name: b!.name, kind: b!.kind, description: b!.description, links: (b!.links as string[]) ?? [], city: b!.city, country: b!.country, ships: b!.ships, placeBy: b!.placeBy }}
      tone={data.tone ?? ""} colors={data.brand_colors ?? []} wishes={data.wishes ?? ""} usage={{ posts: usage.posts, limit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }} wallet={await content.getSetting<string>(`walletOf:${s.handle}`)}
      plan={b?.plan ?? "free"} created={b!.createdAt.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "America/New_York" })} telegramBot={await content.getSetting<string>(`telegramBot:${s.handle}`)}
      email={await content.getSetting<string>(`emailOf:${s.handle}`)} emailOn={!!d.emailOn}
      contact={await content.getSetting<{ email?: string; phone?: string; app?: string }>(`contactOf:${s.handle}`)}
      market={d.marketOn ? { on: !!(await content.getSetting<string>(`marketOn:${s.handle}`)) } : null} />);
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
