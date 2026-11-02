// The shop feed (nearchant.com/feed, ADR 0022): one search box — "stores that sell protein and creatine in New York"
// — and a feed of posts and shorts from the stores that fit. Without a query: "For you" (what this buyer liked pulls
// similar posts up), newest and most liked first. A post opens on its store, where it can be bought.
import type { FC } from "hono/jsx";
import { Badge, Icon, Mark, UiPage, type UiConfig } from "./kit.js";

export interface FeedTile { id: string; handle: string; caption: string; img: string; video: string | null; proofId: string | null; storeName: string; place: string | null; likes: number; liked: boolean }

const playIcon = <span class="dot" style="position:absolute;top:10px;right:10px;width:30px;height:30px;background:rgba(0,0,0,.55)"><Icon n="play" s={14} c="#fff" /></span>;

export const FeedTiles: FC<{ posts: FeedTile[]; next: string | null }> = ({ posts, next }) => (
  <>
    {posts.map((p) => (
      <a class="post feed-tile" href={`/h/${p.handle}/p/${p.id}?ref=feed`} style="color:inherit">
        <div class="img" style={`aspect-ratio:4/5;position:relative;background-image:url('${p.img}')`}>
          {p.video ? <video data-autoplay src={p.video} poster={p.img} muted loop playsinline preload="none" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit"></video> : null}
          {p.video ? playIcon : null}
        </div>
        <div class="spread" style="gap:8px;align-items:center"><span class="foot b clamp1" style="min-width:0">{p.storeName}</span>
          <button class="like" type="button" data-like={p.id} aria-pressed={p.liked ? "true" : "false"} aria-label="Like"><Icon n="heart" s={16} /><span data-n>{p.likes || ""}</span></button></div>
        {p.place ? <span class="cap muted">{p.place}</span> : null}
        <span class="foot clamp3">{p.caption}</span>
        {p.proofId ? <Badge label={`Proof #${p.proofId} on NEAR`} /> : null}
      </a>))}
    {next ? <i data-next={next} hidden></i> : null}
  </>
);

export const ExplorePage: FC<{ cfg: UiConfig; test: boolean; q: string; city: string; summary: string | null; posts: FeedTile[]; next: string | null; suggestions: string[]; forYou: boolean }> = ({ cfg, test, q, city, summary, posts, next, suggestions, forYou }) => (
  <UiPage title={q ? `${q} · Nearchant` : "Shop feed · Nearchant"} cfg={cfg} page="feed" test={test} buyer>
    <div class="land">
      <nav class="land-nav"><a class="land-logo" href="/"><Mark />Nearchant</a>
        <span class="land-links sub"><a href="/feed">Feed</a><a href="/verify">Verify a post</a></span>
        <span class="row" style="gap:14px;align-items:center"><a class="sub" href="#" data-buyer-me>Sign in</a><a class="btn" href="/start">Sell here</a></span></nav>
      <section class="stack" style="max-width:1200px;margin:0 auto;padding:24px 16px 80px;gap:18px">
        <form class="feed-search" action="/feed" method="get">
          <span class="feed-q"><Icon n="sparkles" s={18} c="#AF52DE" /><input class="input" name="q" value={q} maxlength={200} placeholder="What are you looking for? e.g. protein and creatine, a denim jacket" autocomplete="off" /></span>
          <input class="input feed-city" id="feed-city" name="city" value={city} maxlength={60} placeholder="City (optional)" />
          <button class="btn" type="submit">Search</button>
        </form>
        {suggestions.length && !q ? <div class="row" style="gap:8px;flex-wrap:wrap"><span class="foot muted">Try</span>{suggestions.map((s) => <a class="chip" href={`/feed?q=${encodeURIComponent(s)}`}>{s}</a>)}</div> : null}
        <div class="spread" style="align-items:baseline"><h1 class="t2" style="margin:0">{q ? (summary || q) : forYou ? "For you" : "New on Nearchant"}</h1>
          {q ? <a class="sub" href="/feed">Clear</a> : null}</div>
        {q && !posts.length ? <div class="card"><span class="headline">No stores sell that here yet</span><span class="foot muted">Try other words, another city — or <a href="/start">open the first store for it</a>.</span></div> : null}
        <div class="grid4" data-feed-grid><FeedTiles posts={posts} next={null} /></div>
        {next ? <div data-feed-more={next} class="foot muted" style="text-align:center;padding:20px">Loading more…</div> : null}
        <p class="cap muted" style="margin:0">Every post has a proof on NEAR; you pay into escrow and the store is paid when you confirm. Posts are checked by AI moderation; we keep the IP address, email and wallet of accounts that break the rules.</p>
      </section>
    </div>
  </UiPage>
);
