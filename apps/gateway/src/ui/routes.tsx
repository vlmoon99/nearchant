// Page routes of the seller app (ADR 0018). JSON lives in seller-app.ts; these render the Figma screens.
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { PLAN_LIMITS, type ContentStore } from "@nearchant/db";
import { OnboardingPage } from "./onboarding.js";
import { CreatePage, HomePage, PostPage, PostsPage, SignInPage, checklistFor, type StoreView } from "./app-pages.js";
import type { UiConfig } from "./kit.js";
import { readSession } from "../seller-app.js";

export interface UiDeps {
  cfg: UiConfig; test: boolean; css: string; js: string | undefined; sessionKey: Buffer;
  content?: ContentStore;
  accountOf: (handle: string) => string;
  explorer: (accountId: string) => string;
}

export function mountUi(app: Hono<any>, d: UiDeps): void {
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
    return fn({ handle, name: b.name, account: d.accountOf(handle) }, img);
  };

  app.get("/app", (c) => withStore(c, async (s, img) => {
    const [posts, opps, events, usage, b] = await Promise.all([content.listPosts(s.handle, { limit: 50 }), content.listOpportunities(s.handle), content.eventCounts(s.handle, 7), content.usage(s.handle), content.getBusiness(s.handle)]);
    const sum = (k: string) => events.filter((e) => e.kind === k).reduce((a, e) => a + e.n, 0);
    const shown = posts.filter((p) => p.status !== "failed" && (p.chosenAt || p.status !== "ready"));
    return c.html(<HomePage cfg={d.cfg} test={d.test} store={s} posts={shown} img={img} opps={opps}
      stats={{ views: sum("view"), sales: sum("sale"), salesUnits: 0, proofs: posts.filter((p) => p.proof).length, postsMonth: usage.posts, postsLimit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }}
      checklist={checklistFor(b, posts, sum("sale"))} />);
  }));
  app.get("/app/create", (c) => withStore(c, async (s) => {
    const [photos, opps, usage, b] = await Promise.all([content.listMedia(s.handle, "photo"), content.listOpportunities(s.handle), content.usage(s.handle), content.getBusiness(s.handle)]);
    return c.html(<CreatePage cfg={d.cfg} test={d.test} store={s} photos={photos} opps={opps} usage={{ posts: usage.posts, limit: PLAN_LIMITS[b?.plan ?? "free"]!.posts }} />);
  }));
  app.get("/app/posts", (c) => withStore(c, async (s, img) => {
    const f = ["ready", "scheduled", "published"].includes(c.req.query("f") ?? "") ? c.req.query("f")! : "all";
    return c.html(<PostsPage cfg={d.cfg} test={d.test} store={s} posts={(await content.listPosts(s.handle, { limit: 100 })).filter((p) => p.status !== "failed")} img={img} filter={f} />);
  }));
  app.get("/app/posts/:id", (c) => withStore(c, async (s, img) => {
    const p = await content.getPost(c.req.param("id"));
    if (!p || p.handle !== s.handle) return c.notFound();
    return c.html(<PostPage cfg={d.cfg} test={d.test} store={s} p={p} img={img} explorer={d.explorer(s.account)} />);
  }));
}
