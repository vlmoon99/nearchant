// Explore (nearchant.com/explore): the newest posts of every store in one feed. A post opens on its store
// (/h/<store>/p/<id>), where it can be bought from — Nearchant is a place to look, not only a tool for other networks.
import type { FC } from "hono/jsx";
import { Badge, Icon, Mark, UiPage, type UiConfig } from "./kit.js";

export interface FeedPost { id: string; handle: string; caption: string; img: string; video: boolean; proofId: string | null; storeName: string }

export const ExplorePage: FC<{ cfg: UiConfig; test: boolean; posts: FeedPost[]; next: string | null }> = ({ cfg, test, posts, next }) => (
  <UiPage title="Explore · Nearchant" cfg={cfg} page="explore" test={test}>
    <div class="land">
      <nav class="land-nav"><a class="land-logo" href="/"><Mark />Nearchant</a>
        <span class="land-links sub"><a href="/explore">Explore</a><a href="/verify">Verify a post</a></span>
        <a class="btn" href="/start">Create your store</a></nav>
      <section class="stack" style="max-width:1200px;margin:0 auto;padding:32px 16px 80px;gap:20px">
        <h1 class="t1">Explore</h1>
        <p class="body muted" style="margin:0">New posts from stores on Nearchant. Every one has a proof on NEAR, and you buy straight from the store — the money waits in escrow until you get your order.</p>
        {posts.length ? <div class="grid4">{posts.map((p) => (
          <a class="post" href={`/h/${p.handle}/p/${p.id}?ref=explore`} style="color:inherit">
            <div class="img" style={`aspect-ratio:4/5;position:relative;background-image:url('${p.img}')`}>
              {p.video ? <span class="dot" style="position:absolute;top:10px;right:10px;width:30px;height:30px;background:rgba(0,0,0,.55)"><Icon n="play" s={14} c="#fff" /></span> : null}</div>
            <span class="foot b">{p.storeName}</span>
            <span class="foot clamp3">{p.caption}</span>
            {p.proofId ? <Badge label={`Proof #${p.proofId} on NEAR`} /> : null}
          </a>))}</div> : <p class="sub muted">No posts yet — be the first: create your store.</p>}
        {next ? <a class="btn secondary" style="align-self:center" href={`/explore?before=${encodeURIComponent(next)}`}>Older posts</a> : null}
      </section>
    </div>
  </UiPage>
);
