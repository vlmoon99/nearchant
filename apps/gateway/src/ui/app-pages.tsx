// Seller app pages (Figma "Web app (seller)" + "Mobile web" rows): Home, Create, Posts, Post detail with the proof.
import type { FC } from "hono/jsx";
import type { Business, Media, Opportunity, Post } from "@nearchant/db";
import { Badge, Icon, PageHead, Shell, Stat, UiPage, type UiConfig } from "./kit.js";

export interface StoreView { handle: string; name: string; account: string; balance?: string }
type Img = (id: string | null) => string | null;

const money = (cfg: UiConfig, units: string | number) => `${(Number(units) / 10 ** cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${cfg.token}`;
const when = (p: Post) => p.status === "published" ? `Posted ${fmt(p.publishedAt)}` : p.status === "scheduled" ? `Scheduled · ${fmt(p.scheduledAt)}` : p.status === "ready" ? "Ready to post" : p.status === "failed" ? "Could not make this one" : "Making…";
const fmt = (d: Date | null) => (d ? d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" }) : "");
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

export const HomePage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; posts: Post[]; img: Img; opps: Opportunity[]; stats: { views: number; sales: number; salesUnits: number; proofs: number; postsMonth: number; postsLimit: number }; checklist: [string, boolean][] }> = ({ cfg, test, store, posts, img, opps, stats, checklist }) => (
  <Page cfg={cfg} test={test} title="Home" active="Home" store={store}>
    <PageHead kicker={`Hello, ${store.name}`} title="Home"><a class="btn" href="/app/create"><Icon n="plus" />Create post</a></PageHead>
    <a class="dropzone" href="/app/create" style="grid-template-columns:auto 1fr auto;text-align:left;align-items:center;color:inherit">
      <span class="dot" style="width:56px;height:56px;background:var(--bg)"><Icon n="image" s={26} c="#007AFF" /></span>
      <span class="stack s8"><span class="t4">New post from photos</span><span class="sub muted">Pick photos of your item. AI writes the caption, designs the post and picks the best time — every post gets a proof on NEAR.</span></span>
      <span class="btn">Choose photos</span>
    </a>
    <div class="spread"><h2 class="t4">This week</h2><a class="sub" href="/app/analytics">Open analytics</a></div>
    <div class="grid4">
      <Stat label="Store views" value={String(stats.views)} delta={stats.views ? "last 7 days" : "share your link"} />
      <Stat label="Sales from posts" value={money(cfg, stats.salesUnits)} delta={`${stats.sales} order${stats.sales === 1 ? "" : "s"}`} />
      <Stat label="Proofs on NEAR" value={String(stats.proofs)} delta={stats.proofs ? "all verified" : "after the first post"} />
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

export const PostsPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; posts: Post[]; img: Img; filter: string }> = ({ cfg, test, store, posts, img, filter }) => {
  const shown = filter === "all" ? posts : posts.filter((p) => p.status === filter);
  const pending = posts.some((p) => ["queued", "writing", "rendering"].includes(p.status));
  return (
    <Page cfg={cfg} test={test} title="Posts" active="Posts" store={store}>
      <PageHead kicker={`Library · ${posts.length} posts`} title="Posts"><a class="btn" href="/app/create"><Icon n="plus" />Create post</a></PageHead>
      <div class="row" style="gap:8px;flex-wrap:wrap">{[["all", "All"], ["ready", "Ready"], ["scheduled", "Scheduled"], ["published", "Posted"]].map(([k, l]) => <a class={`chip ${filter === k ? "on" : ""}`} href={`/app/posts?f=${k}`}>{l}</a>)}</div>
      {pending ? <p class="foot muted" data-refresh="4000">AI is still making some posts — this page refreshes by itself.</p> : null}
      {shown.length ? <div class="grid4">{shown.map((p) => <PostCard p={p} img={img} />)}</div> : <p class="sub muted">Nothing here yet.</p>}
    </Page>
  );
};

export const PostPage: FC<{ cfg: UiConfig; test: boolean; store: StoreView; p: Post; img: Img; explorer: string }> = ({ cfg, test, store, p, img, explorer }) => {
  const proof = p.proof as { proofId?: string; outputHash?: string; contract?: string } | null;
  return (
    <Page cfg={cfg} test={test} title="Post" active="Posts" store={store}>
      <PageHead kicker={`Posts › ${clip(p.caption ?? "Post", 40)}`} title="Post details" />
      <div class="cols" style="grid-template-columns:minmax(0,420px) 1fr">
        <div class="stack s12">
          <div class="post"><div class="img" style={img(p.imageMediaId) ? `background-image:url('${img(p.imageMediaId)}');aspect-ratio:4/5` : "aspect-ratio:4/5"}></div></div>
          <textarea class="input" id="caption" data-post={p.id} rows={6}>{p.caption ?? ""}</textarea>
          <span class="sub accent">{((p.hashtags as string[]) ?? []).map((h) => `#${h}`).join(" ")}</span>
          <div class="row" style="gap:8px"><button class="btn secondary" id="save-caption" data-post={p.id}>Save caption</button><output class="foot" id="post-out"></output></div>
        </div>
        <div class="stack">
          <div class="card"><span class="headline">Status</span><span class="sub">{when(p)}</span>
            {["ready", "scheduled"].includes(p.status) ? <div class="row" style="gap:10px;flex-wrap:wrap"><button class="btn" data-schedule={p.id} data-when="best"><Icon n="calendar" />Best time</button><button class="btn secondary" data-schedule={p.id} data-when="now"><Icon n="send" />Post now</button></div> : null}
          </div>
          <div class="card proof">
            <div class="spread"><div class="row" style="align-items:center;gap:8px"><Icon n="shield" c="#007A4F" s={20} /><span class="headline proof-t">Proof on NEAR</span></div>{proof?.proofId ? <Badge label="Verified · unchanged" /> : null}</div>
            {proof?.proofId ? <>
              {[["Proof", `#${proof.proofId}`], ["Fingerprint (SHA-256)", `${proof.outputHash?.slice(0, 10)}…${proof.outputHash?.slice(-8)}`], ["Made by", "Nearchant AI · on your own GPU"], ["Owner", store.account], ["Contract", proof.contract ?? ""]].map(([k, v]) => <div class="spread"><span class="foot muted">{k}</span><span class="foot b">{v}</span></div>)}
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
      <a class="btn" href="/start">Create a store</a></section>
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
