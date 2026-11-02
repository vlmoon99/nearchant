// Admin moderation (ADR 0022) — tailnet only, behind a password and the moderator's name. The moderator agent acts
// first (removes clear violations at once); here a person reviews: reports, AI decisions, removed posts (undo),
// suspended stores, banned buyers, the violators list (who is who: NEAR accounts, emails, IPs) and the log.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Context, Hono, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { FC, PropsWithChildren } from "hono/jsx";
import type { ContentStore, FeedStore, Report } from "@nearchant/db";

export interface ModDeps { feed: FeedStore; content: ContentStore; mediaDir: string; password: string; key: Buffer; secureCookies?: boolean; accountOf: (h: string) => string; now?: () => number }

const COOKIE = "nc_admin";
const sign = (key: Buffer, body: string) => `${body}.${createHmac("sha256", key).update(`admin:${body}`).digest("base64url")}`;
function readAdmin(key: Buffer, tok: string | undefined, now: number): string | null {
  if (!tok) return null;
  const i = tok.lastIndexOf(".");
  const body = tok.slice(0, i), mac = Buffer.from(tok.slice(i + 1), "base64url"), want = createHmac("sha256", key).update(`admin:${body}`).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  const [name, exp] = [body.slice(0, body.lastIndexOf(":")), Number(body.slice(body.lastIndexOf(":") + 1))];
  return exp > now && name ? decodeURIComponent(name) : null;
}
const same = (a: string, b: string) => { const x = createHmac("sha256", "cmp").update(a).digest(), y = createHmac("sha256", "cmp").update(b).digest(); return timingSafeEqual(x, y); };
const when = (d: Date | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

const CSS = `body{font-family:Inter,system-ui,sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}main{max-width:1200px;margin:0 auto;padding:20px}
nav{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:16px}nav a{color:#1d1d1f;text-decoration:none;font-weight:600;padding:6px 12px;border-radius:999px}nav a.on{background:#1d1d1f;color:#fff}
.muted{color:#6e6e73}.card{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;display:grid;gap:8px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.case{display:grid;grid-template-columns:120px 1fr;gap:14px}.case img{width:120px;height:150px;object-fit:cover;border-radius:10px;background:#e5e5ea}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:7px 14px;cursor:pointer;background:#f5f5f7}button.danger{background:#ff3b30;color:#fff}button.ok{background:#34c759;color:#fff}
.tag{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:#e5e5ea}.tag.red{background:#ffe5e3;color:#c0392b}.tag.green{background:#e3faf0;color:#007a4f}.tag.amber{background:#fff3c4;color:#5c4a00}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:6px 8px;border-top:1px solid #e5e5ea;vertical-align:top}code{font-size:12px;word-break:break-all}
input,textarea{font:inherit;padding:9px;border:1px solid #d2d2d7;border-radius:10px}form.inline{display:inline}`;

const Shell: FC<PropsWithChildren<{ title: string; who?: string; tab?: string; counts?: Record<string, number> }>> = ({ title, who, tab, counts, children }) => (
  <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title} · Nearchant admin</title><style dangerouslySetInnerHTML={{ __html: CSS }}></style></head>
    <body><main>
      {who ? <nav><b>Nearchant admin</b>
        {[["reports", "Reports"], ["ai", "AI decisions"], ["removed", "Removed posts"], ["stores", "Suspended stores"], ["violators", "Violators"], ["log", "Log"]].map(([k, l]) => <a class={tab === k ? "on" : ""} href={`/mod/${k}`}>{l}{counts?.[k!] ? ` (${counts[k!]})` : ""}</a>)}
        <a href="/">Image lab</a><span class="muted" style="margin-left:auto">{who} · <a href="/mod/logout" style="padding:0">sign out</a></span></nav> : null}
      {children}
    </main></body></html>
);

const Act: FC<{ action: string; label: string; kind?: string; confirm?: string }> = ({ action, label, kind, confirm }) => (
  <form class="inline" method="post" action={action} {...(confirm ? { onsubmit: `return confirm(${JSON.stringify(confirm)})` } : {})}><button class={kind ?? ""} type="submit">{label}</button></form>
);

export function mountModeration(app: Hono, d: ModDeps): void {
  const now = () => (d.now ? d.now() : Date.now());
  let fails = 0, lockedUntil = 0;
  // Everything on the admin port needs a signed-in moderator (the image lab too).
  app.use("*", async (c: Context, next: Next) => {
    const p = c.req.path;
    if (p === "/mod/login") return next();
    const who = readAdmin(d.key, getCookie(c, COOKIE), now());
    if (!who) return c.req.method === "GET" && !p.startsWith("/api/") ? c.redirect("/mod/login", 302) : c.json({ error: "sign in" }, 401);
    c.set("who" as never, who as never);
    return next();
  });
  const who = (c: Context) => c.get("who" as never) as unknown as string;

  app.get("/mod/login", (c) => c.html(<Shell title="Sign in"><form class="card" method="post" action="/mod/login" style="max-width:360px;margin:60px auto">
    <b>Nearchant admin</b><span class="muted">Moderation and the image lab. Tailnet only.</span>
    <input name="name" required maxlength={40} placeholder="Your name (shown in the log)" /><input name="password" type="password" required placeholder="Admin password" />
    <button class="ok" type="submit">Sign in</button></form></Shell>));
  app.post("/mod/login", async (c) => {
    if (now() < lockedUntil) return c.text("Too many wrong passwords — wait a minute.", 429);
    const f = await c.req.parseBody();
    const name = String(f.name ?? "").trim().slice(0, 40), pw = String(f.password ?? "");
    if (!d.password || !name || !same(pw, d.password)) { if (++fails >= 5) { lockedUntil = now() + 60_000; fails = 0; } return c.text("Wrong password.", 401); }
    fails = 0;
    setCookie(c, COOKIE, sign(d.key, `${encodeURIComponent(name)}:${now() + 12 * 3600_000}`), { httpOnly: true, sameSite: "Strict", secure: !!d.secureCookies, path: "/", maxAge: 12 * 3600 });
    await d.feed.log(name, "admin.signin", "admin");
    return c.redirect("/mod/reports", 303);
  });
  app.get("/mod/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.redirect("/mod/login", 302); });
  app.get("/mod", (c) => c.redirect("/mod/reports", 302));

  // Pictures of posts under review (public and not-yet-public ones).
  app.get("/mod/media/*", async (c) => {
    const key = normalize(c.req.path.slice("/mod/media/".length)).replace(/^(\.\.(\/|$))+/, "");
    if (key.includes("..")) return c.notFound();
    const bytes = await readFile(join(d.mediaDir, key)).catch(() => null);
    return bytes ? c.body(bytes, 200, { "content-type": key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : key.endsWith(".mp4") ? "video/mp4" : "image/jpeg", "cache-control": "private, max-age=600" }) : c.notFound();
  });

  const counts = async () => ({ reports: (await d.feed.listReports({ status: ["open"], limit: 500 })).length });
  const postCard = async (postId: string | null) => {
    const p = postId ? await d.content.getPost(postId) : null;
    if (!p) return null;
    const key = (p.idea as { publicImage?: string }).publicImage ?? (p.imageMediaId ? (await d.content.getMedia(p.imageMediaId))?.key : null);
    return { p, img: key ? `/mod/media/${key}` : null, mod: p.moderation as { category?: string; confidence?: number; summary?: string } | null };
  };
  const ReportCase: FC<{ r: Report; post: Awaited<ReturnType<typeof postCard>> }> = ({ r, post }) => (
    <div class="card"><div class="case">{post?.img ? <img src={post.img} alt="" /> : <span></span>}
      <div style="display:grid;gap:6px">
        <div class="row"><b>#{r.id}</b><span class={`tag ${r.status.includes("removed") ? "red" : r.status === "open" ? "amber" : "green"}`}>{r.status.replace("_", " ")}</span><span class="tag">{r.reason}</span>
          <span class="muted">{r.targetKind === "post" ? "post" : "store"} of <a href={`https://nearchant.com/h/${r.handle}/`} target="_blank">{r.handle}</a> · {when(r.createdAt)}</span></div>
        {r.note ? <span>“{r.note}”</span> : null}
        {post ? <span class="muted">{(post.p.caption ?? "").slice(0, 300)}</span> : null}
        {r.ai ? <span><b>AI:</b> {String((r.ai as { category?: string }).category ?? "")} {(r.ai as { confidence?: number }).confidence != null ? `(${Math.round(Number((r.ai as { confidence?: number }).confidence) * 100)}%)` : ""} — {String((r.ai as { summary?: string }).summary ?? JSON.stringify(r.ai)).slice(0, 300)}</span> : <span class="muted">AI has not looked yet.</span>}
        {post?.p.removedAt ? <span class="tag red" style="width:fit-content">post removed: {post.p.removedReason}</span> : null}
        <div class="row">
          {post && !post.p.removedAt ? <Act action={`/mod/report/${r.id}/remove`} label="Remove post" kind="danger" /> : null}
          {post?.p.removedAt ? <Act action={`/mod/report/${r.id}/restore`} label="Restore post (AI was wrong)" kind="ok" /> : null}
          {r.status === "open" || r.status.startsWith("auto") ? <Act action={`/mod/report/${r.id}/keep`} label={post?.p.removedAt ? "Close report" : "Keep — not a violation"} /> : null}
          <Act action={`/mod/store/${r.handle}/suspend`} label="Suspend store" kind="danger" confirm={`Suspend ${r.handle}? Its store and posts disappear.`} />
          {r.reporterBuyerId ? <Act action={`/mod/buyer/${r.reporterBuyerId}/ban`} label="Ban reporter (abuse)" confirm="Ban the buyer who sent this report?" /> : null}
        </div>
        <span class="muted" style="font-size:12px">reporter {r.reporterBuyerId ?? "—"} · IP {r.reporterIp ?? "—"}{r.decidedBy ? ` · decided by ${r.decidedBy} ${when(r.decidedAt)}` : ""}</span>
      </div></div></div>
  );

  app.get("/mod/reports", async (c) => {
    const rs = await d.feed.listReports({ status: ["open"], limit: 200 });
    const cards = await Promise.all(rs.map(async (r) => ({ r, post: await postCard(r.postId) })));
    return c.html(<Shell title="Reports" who={who(c)} tab="reports" counts={await counts()}>
      <p class="muted">Reports the AI could not settle (store reports about delivery, refunds, behaviour) and anything a person should look at.</p>
      {cards.length ? cards.map(({ r, post }) => <ReportCase r={r} post={post} />) : <div class="card">Nothing waiting. 🎉</div>}</Shell>);
  });
  app.get("/mod/ai", async (c) => {
    const rs = await d.feed.listReports({ status: ["auto_removed", "auto_kept"], limit: 200 });
    const cards = await Promise.all(rs.map(async (r) => ({ r, post: await postCard(r.postId) })));
    return c.html(<Shell title="AI decisions" who={who(c)} tab="ai" counts={await counts()}>
      <p class="muted">What the moderator agent decided on its own. Check them; restore a post if it was wrong, remove one it kept.</p>
      {cards.map(({ r, post }) => <ReportCase r={r} post={post} />)}</Shell>);
  });
  app.get("/mod/removed", async (c) => {
    const rows = await d.feed.removedPosts(200);
    return c.html(<Shell title="Removed posts" who={who(c)} tab="removed" counts={await counts()}>
      <p class="muted">Removed by the AI (on publish or after a report) or by a person. Restoring undoes the violation on the store's record.</p>
      {rows.map((p) => <div class="card"><div class="case">{p.image ? <img src={`/mod/media/${p.image}`} alt="" /> : <span></span>}<div style="display:grid;gap:6px">
        <div class="row"><b><a href={`https://nearchant.com/h/${p.handle}/`} target="_blank">{p.handle}</a></b><span class="muted">{when(p.at)}</span><span class="tag red">{p.reason}</span></div>
        <span class="muted">{p.caption.slice(0, 300)}</span><div class="row"><Act action={`/mod/post/${p.id}/restore`} label="Restore" kind="ok" /></div></div></div></div>)}</Shell>);
  });
  app.get("/mod/stores", async (c) => {
    const list = (await d.content.listBusinesses(2000)).filter((b) => b.suspendedAt);
    return c.html(<Shell title="Suspended stores" who={who(c)} tab="stores" counts={await counts()}>
      {list.length ? <table><tr><th>Store</th><th>Since</th><th>Why</th><th></th></tr>{list.map((b) => <tr><td><b>{b.name}</b><br /><code>{b.handle}</code></td><td>{when(b.suspendedAt)}</td><td>{b.suspendedReason}</td><td><Act action={`/mod/store/${b.handle}/unsuspend`} label="Unsuspend" kind="ok" /></td></tr>)}</table> : <div class="card">No suspended stores.</div>}</Shell>);
  });
  app.get("/mod/violators", async (c) => {
    const vs = await d.feed.listViolators(300);
    return c.html(<Shell title="Violators" who={who(c)} tab="violators" counts={await counts()}>
      <p class="muted">Every store or buyer with a removal, a suspension or a ban — with the NEAR accounts, emails and IP addresses they used, so repeat offenders are recognised. Private: never shown publicly.</p>
      <table><tr><th>Who</th><th>Active violations</th><th>NEAR accounts</th><th>Emails</th><th>IPs</th><th>History</th></tr>
        {vs.map((v) => <tr><td><b>{v.subjectKind}</b><br /><code>{v.subjectId}</code></td><td>{v.count}</td><td>{(v.accounts as string[]).map((a) => <div><code>{a}</code></div>)}</td><td>{(v.emails as string[]).map((a) => <div><code>{a}</code></div>)}</td>
          <td>{(v.ips as string[]).map((a) => <div><code>{a}</code></div>)}</td><td>{v.violations.slice(0, 8).map((x) => <div class={x.undone ? "muted" : ""}>{when(x.at)} · {x.category} by {x.by}{x.undone ? " (undone)" : ""} — {x.summary.slice(0, 90)}</div>)}</td></tr>)}</table></Shell>);
  });
  app.get("/mod/log", async (c) => {
    const rows = await d.feed.listLog(300);
    return c.html(<Shell title="Log" who={who(c)} tab="log" counts={await counts()}>
      <table><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Details</th></tr>{rows.map((r) => <tr><td>{when(r.createdAt)}</td><td>{r.actor}</td><td>{r.action}</td><td><code>{r.target}</code></td><td><code>{JSON.stringify(r.data).slice(0, 200)}</code></td></tr>)}</table></Shell>);
  });

  // ── actions (forms) ──
  const identity = async (handle: string) => ({ accounts: [d.accountOf(handle), (await d.content.getSetting<string>(`walletOf:${handle}`)) ?? ""].filter(Boolean), emails: [(await d.content.getSetting<string>(`emailOf:${handle}`)) ?? ""].filter(Boolean) });
  const back = (c: Context) => { const p = c.req.header("referer")?.replace(/^https?:\/\/[^/]+/, "") ?? ""; return c.redirect(/^\/mod\/[\w/-]*$/.test(p) ? p : "/mod/reports", 303); };
  app.post("/mod/report/:id/remove", async (c) => {
    const r = await d.feed.getReport(Number(c.req.param("id")));
    if (!r?.postId) return c.notFound();
    await d.feed.removePost(r.postId, { category: r.reason, confidence: 1, summary: `removed by ${who(c)} after report #${r.id}`, by: who(c), reportId: r.id, identity: await identity(r.handle) });
    await d.feed.decideReport(r.id, "removed", who(c));
    await d.feed.log(who(c), "post.remove", `post:${r.postId}`, { report: r.id });
    return back(c);
  });
  app.post("/mod/report/:id/restore", async (c) => {
    const r = await d.feed.getReport(Number(c.req.param("id")));
    if (!r?.postId) return c.notFound();
    await d.feed.restorePost(r.postId, who(c));
    await d.feed.decideReport(r.id, "kept", who(c));
    await d.feed.log(who(c), "post.restore", `post:${r.postId}`, { report: r.id });
    return back(c);
  });
  app.post("/mod/report/:id/keep", async (c) => {
    const id = Number(c.req.param("id"));
    const r = await d.feed.getReport(id);
    if (!r) return c.notFound();
    await d.feed.decideReport(id, r.status === "auto_removed" ? "removed" : "kept", who(c));
    await d.feed.log(who(c), "report.close", `report:${id}`, { was: r.status });
    return back(c);
  });
  app.post("/mod/post/:id/restore", async (c) => {
    await d.feed.restorePost(c.req.param("id"), who(c));
    await d.feed.log(who(c), "post.restore", `post:${c.req.param("id")}`);
    return back(c);
  });
  app.post("/mod/store/:h/:op{suspend|unsuspend}", async (c) => {
    const h = c.req.param("h"), op = c.req.param("op");
    if (!(await d.content.getBusiness(h))) return c.notFound();
    if (op === "suspend") {
      await d.feed.suspendStore(h, `suspended by ${who(c)}`);
      await d.feed.recordViolation("store", h, await identity(h), { category: "suspended", confidence: 1, summary: `store suspended by ${who(c)}`, by: who(c) });
    } else await d.feed.suspendStore(h, null);
    await d.feed.log(who(c), `store.${op}`, `store:${h}`);
    return back(c);
  });
  app.post("/mod/buyer/:id/:op{ban|unban}", async (c) => {
    const id = c.req.param("id"), op = c.req.param("op");
    const b = await d.feed.getBuyer(id);
    if (!b) return c.notFound();
    await d.feed.banBuyer(id, op === "ban" ? `banned by ${who(c)}` : null);
    if (op === "ban") await d.feed.recordViolation("buyer", id, { accounts: [b.wallet ?? ""].filter(Boolean), emails: [b.email ?? ""].filter(Boolean) }, { category: "banned", confidence: 1, summary: `buyer banned by ${who(c)}`, by: who(c) });
    await d.feed.log(who(c), `buyer.${op}`, `buyer:${id}`);
    return back(c);
  });
}
