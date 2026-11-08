// nearchant.com home (Figma "Landing & web onboarding" → Landing, node 21:674). Numbers and sample posts are real:
// counted from the database and taken from published posts with a proof on NEAR, never placeholders.
import type { FC } from "hono/jsx";
import { Badge, Icon, Mark, UiPage, type UiConfig } from "./kit.js";

export interface LandingPost { caption: string; img: string | null; proofId: string | null; store: string; href: string; line: string }
export interface LandingData {
  posts: LandingPost[];
  stats: { proofs: number; paidOrders: number; stores: number };
  /** A published post with a proof, for "See a verified post"; null → the button is hidden. */
  verifyHref: string | null;
  limits: { free: { posts: number; images: number }; pro: { posts: number; images: number } };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const GRADIENTS = ["linear-gradient(135deg,#c7d9ff 14%,#2b3d80 86%)", "linear-gradient(135deg,#f0dbbd 14%,#8c6b4d 86%)", "linear-gradient(135deg,#ffdbe0 14%,#b25478 86%)"];
/** The caption's first sentence, cut at a word boundary (≤ 60 characters). */
export function firstLine(s: string): string {
  const one = (s.split(/(?<=[.!?])\s/)[0] ?? s).trim();
  if (one.length <= 60) return one;
  return one.slice(0, 60).replace(/\s+\S*$/, "") + "…";
}
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

const Check: FC<{ dark?: boolean; children: unknown }> = ({ dark, children }) => (
  <span class="land-item"><Icon n="check" s={16} c={dark ? "#00ec97" : "var(--proof)"} />{children}</span>
);

export const LandingPage: FC<{ cfg: UiConfig; test: boolean; d: LandingData }> = ({ cfg, test, d }) => {
  const peek = d.posts.slice(0, 3);
  return (
    <UiPage title="Nearchant · posts that sell, paid and proven on NEAR" cfg={cfg} page="landing" test={test}>
      <div class="land">
        <nav class="land-nav">
          <a class="land-logo" href="/"><Mark />Nearchant</a>
          <span class="land-links sub"><a href="#how">How it works</a><a href="/feed">Shop feed</a><a href="/verify">Verify a post</a><a href="#pricing">Pricing</a></span>
          <span class="row" style="gap:16px;align-items:center"><a class="sub only-m" href="/feed">Shop</a><a class="sub" href="/app">Seller sign in</a><a class="btn hide-m" href="/start">Create your store</a></span>
        </nav>

        <section class="land-hero">
          <span class="land-pill"><Icon n="sparkles" s={14} />Your AI content manager — paid and proven on NEAR</span>
          <h1 class="land-h1">Posts that sell.<br />Paid and proven on NEAR.</h1>
          <p class="land-lead">Add a few photos. AI makes your posts, tells you what works, and your buyers pay you directly —
            every post and every payment is recorded on NEAR, so anyone can trust your store.</p>
          <div class="row" style="gap:12px;flex-wrap:wrap;justify-content:center">
            <a class="btn" href="/start">Create your store — free</a>
            {d.verifyHref ? <a class="btn secondary" href={d.verifyHref}><Icon n="shield" s={16} />See a verified post</a> : null}
          </div>
          <span class="foot muted">No crypto needed: we create your NEAR account for you.</span>
          <form class="feed-search" action="/feed" method="get" style="width:100%;max-width:640px;margin-top:8px">
            <span class="feed-q"><Icon n="sparkles" s={18} c="var(--purple)" /><input class="input" name="q" maxlength={200} placeholder="Shopping? Try “protein in New York” or “denim jacket”" aria-label="Search the shop feed" /></span>
            <button class="btn secondary" type="submit">Search stores</button>
          </form>

          <div class="land-peek">
            {/* Real posts first; empty slots are labelled examples, never passed off as real stores. */}
            {[0, 1, 2].map((i) => peek[i] ?? null).map((p, i) => (
              <a class="land-post" href={p?.href ?? "/start"}>
                <div class="land-img" style={p?.img ? `background-image:url('${p.img}')` : `background:${GRADIENTS[i % 3]}`}></div>
                <span class="sub b">{p ? firstLine(p.caption) : ["New drop: relaxed denim", "Linen season is here", "Pink knit is back"][i]}</span>
                <span class="foot muted">{p ? p.line : "Example · your post here"}</span>
                {p?.proofId ? <Badge label={`Proof #${p.proofId} on NEAR`} /> : null}
              </a>
            ))}
            <div class="land-stats">
              <span class="foot muted">On Nearchant so far</span>
              <span class="t2">{plural(d.stats.proofs, "post", "posts")}</span>
              <span class="foot b okt">verified on NEAR · {fmt(d.stats.stores)} stores</span>
              <div class="land-insight"><Icon n="sparkles" s={16} c="var(--purple)" /><span class="foot">AI checks every caption for offers you never made before it goes live.</span></div>
            </div>
          </div>
        </section>

        <section class="land-sec" id="how">
          <h2 class="t1">Three things, one place.</h2>
          <div class="land-pillars">
            {[["sparkles", "AI makes your content", "Drop photos. AI writes captions in your voice, makes post pictures and short videos with a voiceover, and schedules them for the best time."],
              ["chart", "AI tells you what works", "Views and sales per post. Plain-language tips: what to post next and when your buyers are online."],
              ["wallet", "Get paid on NEAR, provably", "Buyers pay in USDC on NEAR. Money waits in escrow until delivery. Every post and payment has a public proof."]].map(([ic, t, s]) => (
              <div class="land-pillar"><span class="land-ic"><Icon n={ic!} s={22} /></span><span class="t4">{t}</span><span class="sub muted">{s}</span></div>
            ))}
          </div>
        </section>

        <section class="land-trust">
          <div class="stack" style="gap:10px;flex:1;min-width:0">
            <h2 class="t2">Why buyers trust Nearchant stores</h2>
            <p class="body" style="margin:0">Every post carries a fingerprint on NEAR: who made it, when, which AI wrote it, and that it wasn’t changed.
              Every order is held in escrow on NEAR until the buyer gets the item. No fake reviews, no disappearing sellers.</p>
          </div>
          <div class="stack" style="gap:14px">
            {[[d.stats.proofs, "posts verified on NEAR"], [d.stats.paidOrders, "orders paid through escrow"], [d.stats.stores, "stores with their own NEAR account"]].map(([n, l]) => (
              <span class="row" style="gap:12px;align-items:center"><span class="t2" style="color:var(--near)">{fmt(Number(n))}</span><span class="sub">{l}</span></span>
            ))}
          </div>
        </section>

        <section class="land-sec" id="pricing">
          <h2 class="t1">Simple pricing.</h2>
          <p class="body muted" style="margin:0">Start free. Pay in USDC from your balance when you need more.</p>
          <div class="land-plans">
            <div class="land-plan">
              <span class="headline">Free</span>
              <span class="row" style="gap:8px;align-items:flex-end"><span class="t1">$0</span><span class="foot faint">forever</span></span>
              <Check>{d.limits.free.posts} posts a month</Check><Check>Analytics with AI tips</Check><Check>Payments & escrow on NEAR</Check><Check>Proof for every post</Check>
              <a class="btn block" href="/start">Create your store</a>
            </div>
            <div class="land-plan dark">
              <span class="headline">Pro</span>
              <span class="row" style="gap:8px;align-items:flex-end"><span class="t1">19 USDC</span><span class="foot faint">per month</span></span>
              <Check dark>{d.limits.pro.posts} posts & {d.limits.pro.images} pictures a month</Check><Check dark>Short videos with voiceover</Check><Check dark>Weekly report & full analytics</Check><Check dark>Priority AI generation</Check>
              <span class="btn block" style="opacity:.6;cursor:default">Coming soon</span>
            </div>
          </div>
        </section>

        <footer class="land-foot foot muted">
          <span>© 2026 Nearchant · open source (MIT) · built on NEAR</span>
          <span class="row" style="gap:24px;flex-wrap:wrap"><a href="/verify">Verify a post</a><a href="https://github.com/vlmoon99/nearchant">GitHub</a></span>
        </footer>
      </div>
    </UiPage>
  );
};
