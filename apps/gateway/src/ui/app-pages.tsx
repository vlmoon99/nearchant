// Seller app pages (Figma "Web app (seller)" + "Mobile web" rows): Home, Create, Posts, Post detail with the proof.
import type { FC } from "hono/jsx";
import type { Business, Media, Opportunity, Post } from "@nearchant/db";
import { Badge, CreateSteps, Icon, PageHead, Shell, Stat, UiPage, type UiConfig } from "./kit.js";

export interface StoreView { handle: string; name: string; account: string; balance?: string }
type Img = (id: string | null) => string | null;

const money = (cfg: UiConfig, units: string | number) => `${(Number(units) / 10 ** cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${cfg.token}`;
const when = (p: Post) => p.status === "published" ? `Posted ${fmt(p.publishedAt)}` : p.status === "scheduled" ? `Scheduled · ${fmt(p.scheduledAt)}` : p.status === "ready" ? "Ready to post" : p.status === "failed" ? "Could not make this one" : "Making…";
const fmt = (d: Date | null) => (d ? d.toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "");
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n) > n * 0.6 ? s.lastIndexOf(" ", n) : n)}…`);

export const PostCard: FC<{ p: Post; img: Img }> = ({ p, img }) => (
  <a class="post" href={`/app/posts/${p.id}`} style="color:inherit">
    <div class="img" style={img(p.imageMediaId) ? `background-image:url('${img(p.imageMediaId)}')` : ""}></div>
    <span class="sub b">{clip(p.caption ?? (p.idea as { angle?: string })?.angle ?? "New post", 70)}</span>
    <span class="foot muted">{when(p)}</span>
    {p.proof ? <Badge /> : null}
  </a>
);

const Page: FC<{ cfg: UiConfig; test: boolean; title: string; active: string; store: StoreView; children?: unknown }> = ({ cfg, test, title, active, store, children }) => (
  <UiPage title={`${title} · ${store.name}`} cfg={cfg} page="app" test={test}><Shell active={active} store={store}>{children as never}</Shell></UiPage>
);

export interface Suggestion { title: string; description: string; photoMediaId: string | null; img: string | null }
export interface ShipOrder { orderId: string; title: string; amount: string; brief: string; state: string }

export const HomePage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; posts: Post[]; img: Img; opps: Opportunity[]; suggestions?: Suggestion[]; items?: { title: string; price: string }[]; orders?: ShipOrder[]; payments?: { title: string; amount: string; when: string; state: string }[]; series?: { views: number[]; sales: number[]; proofs: number[] }; stats: { views: number; sales: number; salesUnits: number; proofs: number; postsMonth: number; postsLimit: number }; checklist: [string, boolean][]; top?: unknown }> = ({ cfg, test, store, posts, img, opps, suggestions = [], items = [], orders = [], stats, checklist, top, payments = [], series }) => (
  <Page cfg={cfg} test={test} title="Home" active="Home" store={store}>
    <PageHead kicker={`Hello, ${store.name}`} title="Home">
      <a class="acct-pill" href="/app/wallet"><i></i><span class="foot b">{store.account}</span>{store.balance ? <span class="foot muted">{store.balance}</span> : null}</a>
      <a class="btn hide-m" href="/app/create"><Icon n="plus" />Create post</a></PageHead>
    {(top as never) ?? null}
    <a class="dropzone banner" href="/app/create">
      <span class="dot" style="width:56px;height:56px;background:var(--bg)"><Icon n="image" s={26} c="#007AFF" /></span>
      <span class="stack s8"><span class="t4">New post from photos</span><span class="sub muted">Pick photos of your item. AI writes the caption, designs the post and picks the best time — every post gets a proof on NEAR.</span></span>
      <span class="btn">Choose photos</span>
    </a>
    <div class="spread"><h2 class="t4">This week</h2><a class="sub" href="/app/analytics">Open analytics</a></div>
    <div class="grid4">
      <Stat label="Store views" value={String(stats.views)} delta={stats.views ? "last 7 days" : "share your link"} bars={series?.views} />
      <Stat label="Sales from posts" value={money(cfg, stats.salesUnits)} delta={`${stats.sales} order${stats.sales === 1 ? "" : "s"}`} bars={series?.sales} />
      <Stat label="Proofs on NEAR" value={String(stats.proofs)} delta={stats.proofs ? "all verified" : "after the first post"} bars={series?.proofs} />
      <Stat label="Posts this month" value={`${stats.postsMonth} / ${stats.postsLimit}`} delta="free plan" />
    </div>
    <div class="cols">
      <div class="stack">
        <div class="spread"><h2 class="t4">Your posts</h2><a class="sub" href="/app/posts">See all</a></div>
        {posts.length ? <div class="grid3">{posts.slice(0, 6).map((p) => <PostCard p={p} img={img} />)}</div> : <p class="sub muted">No posts yet — <a href="/app/create">make your first ones</a>.</p>}
      </div>
      <div class="stack">
        <div class="card"><div class="row" style="align-items:center;gap:8px"><Icon n="sparkles" c="#AF52DE" /><span class="headline">Ways to sell more</span></div>
          {opps.length ? opps.slice(0, 3).map((o) => <div class="card white" style="gap:4px;padding:12px;border:0"><span class="foot b">{o.title}</span><span class="foot muted">{o.why}</span><span class="foot b okt">≈ +{money(cfg, o.estimateUnits)}/mo</span></div>) : <span class="foot muted">AI looks for opportunities after it learns your store.</span>}
          <a class="foot b" href="/app/create">Make a post for one →</a>
        </div>
        {orders.length ? <div class="card soft"><span class="headline">Orders to ship</span>
          {orders.map((o) => <div class="card white" style="gap:6px;padding:12px;border:0"><div class="spread"><span class="foot b">{o.title}</span><span class="foot b">{o.amount}</span></div><span class="foot muted">{o.brief}</span>
            {o.state === "paid" ? <div class="row" style="gap:8px"><input class="input" data-ship-note={o.orderId} placeholder="Tracking number (optional)" style="padding:8px 10px" /><button class="btn" data-ship={o.orderId}>Mark shipped</button></div> : <span class="foot proof-t">{o.state === "delivered" ? "Shipped · waiting for the buyer to confirm" : o.state}</span>}</div>)}
        </div> : null}
        <div class="card"><div class="spread"><span class="headline">Payments</span><a class="foot" href="/app/wallet">View all</a></div>
          {payments.length ? payments.map((o) => <div class="spread"><span class="stack" style="gap:2px;min-width:0"><span class="foot b">{o.title}</span><span class="cap proof-t">{o.when} · {o.state}</span></span><span class="sub b okt">+{o.amount}</span></div>)
            : <span class="foot muted">No payments yet. Buyers pay into escrow on NEAR; it shows up here.</span>}
          <div class="spread" style="border-top:1px solid var(--sep);padding-top:12px"><span class="stack" style="gap:2px"><span class="cap muted">Balance</span><span class="headline">{store.balance ?? "—"}</span></span><a class="btn secondary" href="/app/wallet">Wallet</a></div>
        </div>
        <div class="card"><span class="headline">Your shop</span>
          {items.map((i) => <div class="spread"><span class="foot">{i.title}</span><span class="foot b">{i.price}</span></div>)}
          {suggestions.length ? <span class="foot muted">AI found these in your photos — set a price to sell them:</span> : null}
          {suggestions.map((sg) => <div class="row" style="gap:8px;align-items:center" data-suggest={sg.title} data-desc={sg.description} data-photo={sg.photoMediaId ?? ""}>
            <span class="th" style={`width:44px;height:44px;border-radius:10px;flex:none;background:var(--grouped) center/cover${sg.img ? ` url('${sg.img}')` : ""}`}></span>
            <span class="foot b" style="flex:1;min-width:0">{sg.title}</span>
            <input class="input" type="number" min="0.5" step="0.5" placeholder="Price" style="width:84px;padding:8px" /><button class="chip" data-add-item>Sell</button></div>)}
          {items.length ? <a class="foot b" href={`/h/${store.handle}/`} target="_blank">Open your store →</a> : null}
        </div>
        <div class="card"><div class="spread"><span class="headline">Getting started</span><span class="foot b muted">{checklist.filter((c) => c[1]).length} of {checklist.length}</span></div>
          {checklist.map(([t, done]) => <div class="row" style="align-items:center;gap:10px"><span class={`dot ${done ? "ok" : "todo"}`} style="width:22px;height:22px">{done ? <Icon n="check" s={13} /> : null}</span><span class={`sub ${done ? "muted" : "b"}`}>{t}</span></div>)}
        </div>
      </div>
    </div>
  </Page>
);

export const CreatePage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; photos: Media[]; opps: Opportunity[]; usage: { posts: number; limit: number } }> = ({ cfg, test, store, photos, opps, usage }) => (
  <Page cfg={cfg} test={test} title="Create" active="Create" store={store}>
    <PageHead kicker="New post" title="Create" />
    <CreateSteps step={1} />
    <div class="cols">
      <div class="stack">
        <label class="dropzone"><span class="dot" style="width:52px;height:52px;background:var(--bg)"><Icon n="upload" s={24} c="#007AFF" /></span><span class="t4">Add photos of your item</span><span class="foot muted">JPG or PNG · we never post them without your OK</span><input type="file" id="create-photos" accept="image/*" multiple class="hidden" /></label>
        <div class="thumbs" id="create-thumbs">{photos.map((m) => <div class="th" style={`background-image:url('/files/${m.key}')`}></div>)}</div>
        <div class="row" style="align-items:center;gap:8px"><Icon n="sparkles" c="#AF52DE" /><span class="headline">Pick an idea — AI suggested these</span></div>
        {opps.map((o, i) => <label class={`option ${i === 0 ? "on" : ""}`} data-opp-pick={o.id}><span class="stack" style="gap:2px"><span class="callout b">{o.title}</span><span class="foot muted">{o.why}</span></span></label>)}
        <label class="field">Or write your own idea<input class="input" id="create-about" placeholder="e.g. restock of the black jacket, size M" maxlength={300} /></label>
      </div>
      <div class="stack">
        <div class="card"><span class="headline">Your posts</span>
          {[["Options", "3 to choose from"], ["Picture", "AI restyles your photo"], ["Best time", "picked by AI"], ["This month", `${usage.posts} of ${usage.limit} posts`]].map(([k, v]) => <div class="spread"><span class="foot muted">{k}</span><span class="foot b">{v}</span></div>)}
          <div class="row" style="gap:10px"><Icon n="shield" c="#007A4F" /><span class="foot proof-t">After you publish, the post is recorded on NEAR — anyone can check it’s yours and unchanged.</span></div>
        </div>
        <button class="btn block" id="create-go"><Icon n="sparkles" />Create posts</button>
        <output class="foot" id="create-out"></output>
      </div>
    </div>
  </Page>
);

export const PostsPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; posts: Post[]; img: Img; filter: string; batch?: string }> = ({ cfg, test, store, posts, img, filter, batch }) => {
  // ?batch=… right after Create: only that batch, with step 2 (AI making it) or 3 (review & publish).
  const inBatch = batch ? posts.filter((p) => p.batchId === batch) : [];
  const shown = inBatch.length ? inBatch : filter === "all" ? posts : posts.filter((p) => p.status === filter);
  const pending = (inBatch.length ? inBatch : posts).some((p) => ["queued", "writing", "rendering"].includes(p.status));
  return (
    <Page cfg={cfg} test={test} title="Posts" active={inBatch.length ? "Create" : "Posts"} store={store}>
      {inBatch.length ? <><PageHead kicker="New post" title={pending ? "AI is making your posts" : "Review & publish"} /><CreateSteps step={pending ? 2 : 3} />
        <p class="sub muted" style="margin:0">{pending ? "Writing captions and making pictures — usually under two minutes." : "Open the ones you like, edit if you want, then post now or at the best time."}</p></>
      : <PageHead kicker={`Library · ${posts.length} posts`} title="Posts"><a class="btn" href="/app/create"><Icon n="plus" />Create post</a></PageHead>}
      {inBatch.length ? null : <div class="row" style="gap:8px;flex-wrap:wrap">{[["all", "All"], ["ready", "Ready"], ["scheduled", "Scheduled"], ["published", "Posted"]].map(([k, l]) => <a class={`chip ${filter === k ? "on" : ""}`} href={`/app/posts?f=${k}`}>{l}</a>)}</div>}
      {pending ? <p class="foot muted" data-refresh="4000">AI is still making some posts — this page refreshes by itself.</p> : null}
      {shown.length ? <div class="grid4">{shown.map((p) => <PostCard p={p} img={img} />)}</div> : <p class="sub muted">Nothing here yet.</p>}
    </Page>
  );
};

const writerOf = (p: Post) => (p.idea as { writer?: { model: string; tier: string; reportHash?: string } } | null)?.writer;
/** Who wrote the post, said plainly: a NEAR AI TEE (with a report), the store's own GPU, or the cloud. */
export function madeBy(p: Post): string {
  const w = writerOf(p);
  if (!w) return "Nearchant AI";
  const model = w.model.split("/").pop()!.replace(/-A3B.*$/i, "").replace(/-/g, " ");
  return w.reportHash ? `${model} · private NEAR AI TEE (attested)` : w.tier === "local" ? `${model} · on your own GPU` : `${model} · ${w.tier}`;
}

export const PostPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; p: Post; img: Img; explorer: string }> = ({ cfg, test, store, p, img, explorer }) => {
  const proof = p.proof as { proofId?: string; outputHash?: string; contract?: string } | null;
  const video = (p.idea as { video?: { status?: string; key?: string; mediaId?: string; error?: string; script?: { hook?: string } } } | null)?.video;
  const making = video && ["writing", "rendering"].includes(video.status ?? "");
  const check = (p.idea as { check?: { invented_offer: number; flagged: boolean } } | null)?.check;
  return (
    <Page cfg={cfg} test={test} title="Post" active="Posts" store={store}>
      <PageHead kicker={`Posts › ${clip(p.caption ?? "Post", 40)}`} title="Post details" />
      <div class="cols post-cols">
        <div class="stack s12">
          <div class="post"><div class="img" style={img(p.imageMediaId) ? `background-image:url('${img(p.imageMediaId)}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div></div>
          {video?.status === "ready" && video.key ? <video src={`/files/${video.key}?v=${(video.mediaId ?? "").slice(-8)}`} controls playsinline preload="metadata" style="width:100%;max-width:360px;aspect-ratio:9/16;border-radius:16px;background:#000"></video> : null}
          {check?.flagged ? <div class="card" style="background:#fff3c4;gap:4px"><span class="callout b">Check this caption before it goes live</span>
            <span class="foot">Our AI check (Levanto Sage on NEAR AI) thinks it may promise something your store doesn’t say — a discount, free delivery, a gift, a deadline or a different price ({Math.round(check.invented_offer * 100)}% sure). Edit it, or post it if the offer is real.</span></div> : null}
          <textarea class="input" id="caption" data-post={p.id} rows={6}>{p.caption ?? ""}</textarea>
          <span class="sub accent">{((p.hashtags as string[]) ?? []).map((h) => `#${h}`).join(" ")}</span>
          <div class="row" style="gap:8px"><button class="btn secondary" id="save-caption" data-post={p.id}>Save caption</button><output class="foot" id="post-out"></output></div>
        </div>
        <div class="stack">
          <div class="card"><span class="headline">Status</span><span class="sub">{when(p)}</span>
            {["ready", "scheduled"].includes(p.status) ? <div class="row" style="gap:10px;flex-wrap:wrap"><button class="btn" data-schedule={p.id} data-when="best"><Icon n="calendar" />Best time</button><button class="btn secondary" data-schedule={p.id} data-when="now"><Icon n="send" />Post now</button></div> : null}
          </div>
          {["ready", "scheduled", "published"].includes(p.status) ? <div class="card" {...(making ? { "data-refresh": "6000" } : {})}><span class="headline">Video</span>
            {making ? <span class="sub">AI is making a 15-second video with an English voiceover and captions — about 3 minutes. This page refreshes by itself.</span>
              : video?.status === "ready" ? <span class="sub">Ready{video.script?.hook ? ` · “${video.script.hook}”` : ""}. It goes on your store with the post.</span>
              : <>{video?.status === "failed" ? <span class="foot" style="color:#c0392b">The last try failed: {video.error ?? "unknown error"}</span> : null}
                <span class="sub muted">Turn this post into a 10–15 s vertical video: the picture comes alive, a voice tells the story, captions on screen. Uses 3 picture credits.</span>
                <button class="btn secondary" data-make-video={p.id}><Icon n="sparkle" />Make a video</button></>}
          </div> : null}
          <div class="card proof">
            <div class="spread"><div class="row" style="align-items:center;gap:8px"><Icon n="shield" c="#007A4F" s={20} /><span class="headline proof-t">Proof on NEAR</span></div>{proof?.proofId ? <Badge label="Verified · unchanged" /> : null}</div>
            {check && !proof?.proofId ? <span class="foot muted">AI check: {check.flagged ? "may promise an offer you didn’t state" : "no invented offers found"} — recorded in the proof when it goes live.</span> : null}
            {proof?.proofId ? <>
              {[["Proof", `#${proof.proofId}`], ["Fingerprint (SHA-256)", `${proof.outputHash?.slice(0, 10)}…${proof.outputHash?.slice(-8)}`], ["Made by", madeBy(p)], ["Owner", store.account], ["Contract", proof.contract ?? ""]].map(([k, v]) => <div class="spread"><span class="foot muted">{k}</span><span class="foot b">{v}</span></div>)}
              {writerOf(p)?.reportHash ? <a class="foot" href={`/attestations/${writerOf(p)!.reportHash}.json`} target="_blank" rel="noopener">TEE attestation report (SHA-256 {writerOf(p)!.reportHash!.slice(0, 10)}…)</a> : null}
              <a class="btn near" href={explorer} target="_blank" rel="noopener"><Icon n="globe" />View on NEAR explorer</a>
            </> : <span class="foot">When this post goes live we record its fingerprint, the time and the AI that made it on NEAR — buyers can verify it’s really from {store.name}.</span>}
          </div>
        </div>
      </div>
    </Page>
  );
};

export const SignInPage: FC<{ cfg: UiConfig; test: boolean }> = ({ cfg, test }) => (
  <UiPage title="Sign in · Nearchant" cfg={cfg} page="signin" test={test}>
    <section class="onb"><span class="logo" style="padding:0"><span class="mark">N</span>Nearchant</span>
      <h1 class="t2">Signing you in…</h1><p class="sub muted" id="signin-msg">Using the store key saved in this browser.</p>
      <button class="btn near" data-wallet="signin"><Icon n="wallet" />Sign in with NEAR wallet</button>
      <a class="btn secondary" href="/start">Create a store</a>
      <span class="cap muted">The wallet signs a one-time message — no transaction, no fee. Link it first in Settings → NEAR wallet.</span></section>
  </UiPage>
);

export function checklistFor(b: Business | null, posts: Post[], sales: number): [string, boolean][] {
  return [
    ["Store created", !!b], ["NEAR account ready", !!b],
    ["First posts scheduled", posts.some((p) => ["scheduled", "published"].includes(p.status))],
    ["First post live with a proof", posts.some((p) => !!p.proof)],
    ["First sale", sales > 0],
  ];
}
