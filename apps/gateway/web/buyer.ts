// Buyer side of Nearchant (ADR 0022), on the feed, store and post pages: likes, reports, sign-in (email link or any
// NEAR wallet — the wallet chooser loads on demand from /assets/wallet.js), shorts that play when in view, and
// infinite scroll on the feed.
type Me = { id: string; email: string | null; wallet: string | null } | null;
const cfgEl = document.getElementById("nc-buyer");
const cfg = (cfgEl ? JSON.parse(cfgEl.textContent ?? "{}") : {}) as { network?: string; walletJs?: string; main?: string; mainPath?: string };
// On a store's own subdomain the buyer account (cookie) is not there: buyer actions continue on the main site.
if (cfg.main && cfg.mainPath && location.origin !== cfg.main) {
  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-like],[data-report-post],[data-report-store],[data-follow],[data-buyer-me],form.order button[type=submit]");
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    location.href = `${cfg.main}${cfg.mainPath}${location.pathname === "/" ? "/" : location.pathname}${location.search}`;
  }, true);
}
let me: Me | undefined;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${res.status}`), { code: (j as { code?: string }).code });
  return j as T;
}
// Both roles of this browser: the buyer account and the store it is signed in to (the shopping ↔ selling switch).
// On a store's own subdomain neither cookie is there; its buttons continue on the main site (above).
type MyStore = { handle: string; name: string } | null;
let myStore: MyStore | undefined;
const onMain = !cfg.main || location.origin === cfg.main;
async function loadRoles(): Promise<void> {
  const r = onMain ? await api<{ buyer: Me; store: MyStore }>("/api/me").catch(() => null) : null;
  me = r?.buyer ?? null; myStore = r?.store ?? null;
}
const getMe = async (): Promise<Me> => { if (me === undefined) await loadRoles(); return me ?? null; };
const getStore = async (): Promise<MyStore> => { if (myStore === undefined) await loadRoles(); return myStore ?? null; };

function sheet(html: string): { el: HTMLElement; close: () => void } {
  const back = document.createElement("div");
  back.className = "sheet-back";
  back.innerHTML = `<div class="sheet card" role="dialog" aria-modal="true"><button class="sheet-x" aria-label="Close">×</button>${html}</div>`;
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  back.querySelector(".sheet-x")!.addEventListener("click", close);
  document.body.append(back);
  return { el: back.querySelector(".sheet") as HTMLElement, close };
}

/** Sign-in sheet: email link or a NEAR wallet. Resolves when signed in (wallet) or the email was sent. */
function signInSheet(why: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = sheet(`<span class="headline">Sign in to Nearchant</span><span class="foot muted">${why}</span>
      <form class="stack" style="gap:8px"><input class="input" type="email" name="email" required placeholder="Your email" autocomplete="email"><button class="btn" type="submit">Email me a sign-in link</button></form>
      <button class="btn near" data-w>Use a NEAR wallet</button><span class="cap muted">Meteor, HOT, HERE, Intear, MyNearWallet and more — a one-time signed message, no fee.</span><output class="foot"></output>
      ${sellRow(myStore ?? null)}`);
    const out = s.el.querySelector("output")!;
    s.el.querySelector("form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/buyer/email", { email: (s.el.querySelector("[name=email]") as HTMLInputElement).value, back: location.pathname + location.search });
        out.textContent = "Check your inbox — the link signs you in on this device.";
      } catch (err) { out.textContent = (err as Error).message; }
    });
    s.el.querySelector("[data-w]")!.addEventListener("click", async () => {
      out.textContent = "Loading wallets…";
      try {
        const { signWithWallet } = (await import(cfg.walletJs ?? "/assets/wallet.js")) as typeof import("./wallet.js");
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const req = { message: `nearchant:buyer:signin:${Date.now()}`, nonce, recipient: location.host, callbackUrl: `${location.origin}/app/wallet-connect` };
        sessionStorage.setItem("nc-wallet", JSON.stringify({ purpose: "buyer", message: req.message, nonce: btoa(String.fromCharCode(...nonce)), recipient: req.recipient, callbackUrl: req.callbackUrl, back: location.pathname + location.search }));
        s.close();
        const signed = await signWithWallet(cfg.network ?? "testnet", req, "Sign in with your NEAR wallet");
        if (!signed) return resolve(false); // closed, or the wallet redirected (it comes back to /app/wallet-connect)
        await api("/api/buyer/wallet", { ...signed, message: req.message, nonce: btoa(String.fromCharCode(...nonce)), recipient: req.recipient, callbackUrl: req.callbackUrl });
        sessionStorage.removeItem("nc-wallet");
        me = undefined; resolve(true);
      } catch (err) { out.textContent = (err as Error).message; resolve(false); }
    });
  });
}

// ── likes ──
document.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-like]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (!(await getMe()) && !(await signInSheet("Sign in to like posts — we keep what you like to show you more of it."))) return;
  const on = b.getAttribute("aria-pressed") !== "true";
  try {
    const r = await api<{ likes: number }>("/api/feed/like", { postId: b.dataset.like, on });
    b.setAttribute("aria-pressed", String(on));
    const n = b.querySelector("[data-n]"); if (n) n.textContent = r.likes ? String(r.likes) : "";
  } catch (err) { if ((err as { code?: string }).code === "signin") { me = null; void signInSheet("Sign in to like posts."); } }
});

// Mark what this buyer liked already (pages are cached per store, likes are per buyer).
void (async () => {
  const btns = [...document.querySelectorAll<HTMLElement>("[data-like]")];
  if (!btns.length || !(await getMe())) return;
  const { liked } = await api<{ liked: string[] }>(`/api/feed/liked?ids=${[...new Set(btns.map((b) => b.dataset.like))].join(",")}`).catch(() => ({ liked: [] as string[] }));
  for (const b of btns) if (liked.includes(b.dataset.like!)) b.setAttribute("aria-pressed", "true");
})();

// ── follow a store ──
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-follow]")) {
  const label = (on: boolean, n: number) => { b.setAttribute("aria-pressed", String(on)); b.querySelector("[data-l]")!.textContent = on ? "Following" : "Follow"; b.querySelector("[data-n]")!.textContent = n ? String(n) : ""; };
  void api<{ following: boolean; followers: number }>(`/api/store/follow?handle=${encodeURIComponent(b.dataset.follow!)}`).then((r) => label(r.following, r.followers)).catch(() => {});
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!(await getMe()) && !(await signInSheet("Sign in to follow this store — its new posts come first in your feed."))) return;
    try { const r = await api<{ following: boolean; followers: number }>("/api/store/follow", { handle: b.dataset.follow, on: b.getAttribute("aria-pressed") !== "true" }); label(r.following, r.followers); }
    catch (err) { if ((err as { code?: string }).code === "signin") { me = null; void signInSheet("Sign in to follow stores."); } }
  });
}

// ── reports ──
const REASONS: [string, string][] = [["scam", "Scam or fraud"], ["illegal", "Illegal goods"], ["sexual", "Sexual content"], ["violence", "Violence"], ["hate", "Hate or harassment"], ["counterfeit", "Fake brand / replica"], ["spam", "Spam or misleading"], ["other", "Something else"]];
document.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-report-post],[data-report-store]");
  if (!b) return;
  e.preventDefault();
  if (!(await getMe()) && !(await signInSheet("Sign in to report — it keeps reports honest."))) return;
  const s = sheet(`<span class="headline">Report ${b.dataset.reportPost ? "this post" : "this store"}</span><span class="foot muted">Our moderation checks it right away; a person reviews what it is unsure about.</span>
    <form class="stack" style="gap:8px">${REASONS.map(([k, l]) => `<label class="row" style="gap:8px;align-items:center"><input type="radio" name="reason" value="${k}" required> <span class="sub">${l}</span></label>`).join("")}
    <textarea class="input" name="note" maxlength="1000" rows="3" placeholder="What is wrong? (optional)"></textarea><button class="btn" type="submit">Send report</button><output class="foot"></output></form>`);
  s.el.querySelector("form")!.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget as HTMLFormElement, out = f.querySelector("output")!;
    try {
      await api("/api/report", { postId: b.dataset.reportPost ?? null, handle: b.dataset.reportStore ?? null, reason: (f.elements.namedItem("reason") as RadioNodeList).value, note: (f.elements.namedItem("note") as HTMLTextAreaElement).value });
      f.innerHTML = `<span class="sub">Thank you — we're checking it now.</span>`;
      setTimeout(s.close, 1800);
    } catch (err) { out.textContent = (err as Error).message; }
  });
});

// ── ask the store (its AI assistant) ──
for (const f of document.querySelectorAll<HTMLFormElement>("form[data-ask]")) {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = f.querySelector("output")!, btn = f.querySelector("button")!, input = f.elements.namedItem("question") as HTMLInputElement;
    btn.disabled = true; out.textContent = "Thinking…";
    try {
      const r = await api<{ answer: string; askOwner: boolean; itemId: string | null }>(new URL(f.action).pathname, { question: input.value });
      out.textContent = r.answer;
      if (r.itemId) { const a = document.createElement("a"); a.href = `${new URL(f.action).pathname.replace(/public\/ask$/, "")}i/${r.itemId}`; a.textContent = " See the item ›"; out.append(a); }
      if (r.askOwner) { const n = document.createElement("span"); n.className = "cap muted"; n.textContent = " (The owner can tell you more.)"; out.append(n); }
    } catch (err) { out.textContent = (err as Error).message; }
    finally { btn.disabled = false; }
  });
}

// ── header: who is signed in ──
// Signed in: the name opens an account sheet (orders, liked, following, sign out with a confirmation) — it used to
// sign out on the first tap. Not signed in: the sign-in sheet.
const site = cfg.main ?? "";
const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The way to selling, in the account and sign-in sheets: your store, or opening one with the same sign-in. */
function sellRow(st: MyStore): string {
  return st
    ? `<div class="list"><a class="list-row nav" href="${site}/sell" data-switch-sell><span class="list-ic" style="background:var(--green)">${STORE_SVG}</span><span class="list-text"><span class="body">Switch to selling</span><span class="foot muted">${esc(st.name)}</span></span></a></div>`
    : `<div class="list"><a class="list-row nav" href="${site}/sell" data-become-seller><span class="list-ic" style="background:var(--green)">${STORE_SVG}</span><span class="list-text"><span class="body">Become a seller</span><span class="foot muted">Open a free store for your items or services — same sign-in</span></span></a></div>`;
}
const STORE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z"/><path d="M5 13v7h14v-7"/></svg>`;
function accountSheet(m: NonNullable<Me>) {
  const name = m.email ?? m.wallet ?? "Signed in";
  const s = sheet(`<span class="headline">Your account</span><span class="foot muted">${esc(name)}</span>
    ${sellRow(myStore ?? null)}
    <div class="list"><a class="list-row nav" href="${site}/feed/orders"><span class="list-text"><span class="body">My orders</span></span></a>
      <a class="list-row nav" href="${site}/feed/following"><span class="list-text"><span class="body">Stores you follow</span></span></a>
      <a class="list-row nav" href="${site}/feed/liked"><span class="list-text"><span class="body">Posts you liked</span></span></a></div>
    <button class="btn secondary" data-out style="color:var(--red)">Sign out</button>`);
  s.el.querySelector("[data-out]")!.addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to sign out"; return; }
    await api("/api/buyer/logout", {}).catch(() => {}); location.reload();
  });
}
for (const el of document.querySelectorAll<HTMLElement>("[data-buyer-me]")) {
  // The tap works at once; who is signed in is asked then (it may still be loading).
  el.addEventListener("click", async (e) => {
    e.preventDefault();
    const m = await getMe();
    if (m) accountSheet(m);
    else { await getStore(); if (await signInSheet("Keep your orders, likes and the stores you follow on every device.")) location.reload(); }
  });
  void getMe().then((m) => {
    if (!m) return;
    const label = el.querySelector<HTMLElement>("[data-buyer-label]");
    const short = (m.email ?? m.wallet ?? "You").replace(/@.*/, "").slice(0, 14);
    if (label) label.textContent = el.hasAttribute("data-buyer-tab") ? "You" : short; else el.textContent = short;
    el.title = `Signed in as ${m.email ?? m.wallet ?? ""}`;
  });
}

// "Sell on Nearchant" → "Your store" when this browser is signed in to one.
void getStore().then((st) => {
  if (!st) return;
  for (const a of document.querySelectorAll<HTMLElement>("[data-sell-link]")) {
    const l = a.querySelector("[data-sell-label]"); if (l) l.textContent = "Your store";
    a.title = `Switch to selling — ${st.name}`;
  }
});

// Orders paid in this browser before signing in join the account (once signed in, on every page load; cheap).
void getMe().then(async (m) => {
  if (!m) return;
  let list: { orderId: string }[] = [];
  try { list = JSON.parse(localStorage.getItem(`nc:${cfg.network}:orders`) ?? "[]"); } catch { /* none */ }
  const k = `nc:${cfg.network}:claimed:${m.id}`;
  let done: string[] = []; try { done = JSON.parse(localStorage.getItem(k) ?? "[]"); } catch { /* none */ }
  const todo = list.filter((o) => o && typeof o.orderId === "string" && !done.includes(o.orderId)).map((o) => ({ orderId: o.orderId }));
  if (!todo.length) return;
  const r = await api<{ claimed: number }>("/api/buyer/claim-orders", { orders: todo }).catch(() => null);
  if (!r) return;
  try { localStorage.setItem(k, JSON.stringify([...done, ...todo.map((o) => o.orderId)].slice(-200))); } catch { /* ignore */ }
  if (r.claimed && location.pathname === "/feed/orders") location.reload();
});

// My orders: orders paid in this browser (saved by the checkout), with their state — also for buyers who never signed in.
const localBox = document.querySelector<HTMLElement>("[data-local-orders]");
if (localBox) {
  const known = new Set(JSON.parse(localBox.dataset.localOrders || "[]") as string[]);
  let list: { orderId: string; handle: string; title: string; store: string; amount: string; at: string }[] = [];
  try { list = JSON.parse(localStorage.getItem(`nc:${cfg.network}:orders`) ?? "[]"); } catch { /* none */ }
  const label: Record<string, string> = { paid: "Paid — in escrow", in_progress: "Being prepared", delivered: "Shipped — confirm when you get it", released: "Done", refunded: "Refunded" };
  void (async () => {
    const rows = await Promise.all(list.filter((o) => !known.has(o.orderId)).map(async (o) => {
      const r = await fetch(`/h/${o.handle}/public/orders/${o.orderId}`).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { state?: string } | null;
      return r && r.state && r.state !== "awaiting_payment" ? { ...o, state: r.state } : null;
    }));
    const shown = rows.filter((x): x is NonNullable<typeof x> => !!x);
    if (!shown.length) return;
    document.querySelector("[data-no-orders]")?.remove();
    localBox.innerHTML = `<span class="group-h">In this browser</span>` + shown.map((o) => `<a class="card white" href="/h/${encodeURIComponent(o.handle)}/o/${encodeURIComponent(o.orderId)}" style="flex-direction:row;gap:12px;align-items:center;color:inherit">
      <span class="stack" style="gap:2px;flex:1;min-width:0"><span class="callout b">${esc(o.title)}</span><span class="foot muted">${esc(o.store)} · ${esc(o.at.slice(0, 10))}</span></span>
      <span class="stack" style="gap:2px;align-items:flex-end"><span class="sub b">${esc(o.amount)}</span><span class="cap ${o.state === "delivered" ? "warn-t" : "muted"}">${esc(label[o.state] ?? o.state)}</span></span></a>`).join("");
  })();
}

// ── shorts play muted while on screen ──
const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => { for (const x of es) { const v = x.target as HTMLVideoElement; if (x.isIntersecting) void v.play().catch(() => {}); else v.pause(); } }, { threshold: 0.6 }) : null;
const watch = (root: ParentNode) => root.querySelectorAll<HTMLVideoElement>("video[data-autoplay]").forEach((v) => { v.muted = true; io?.observe(v); });
watch(document);

// ── feed: more results as you scroll ──
const more = document.querySelector<HTMLElement>("[data-feed-more]");
if (more && "IntersectionObserver" in window) {
  let busy = false;
  new IntersectionObserver(async (es) => {
    if (!es[0]?.isIntersecting || busy || !more.dataset.feedMore) return;
    busy = true;
    const u = new URL(more.dataset.feedMore, location.origin);
    try {
      const res = await fetch(`/feed/more${u.search}`, { credentials: "same-origin" });
      const html = await res.text();
      const grid = document.querySelector("[data-feed-grid]")!;
      const t = document.createElement("template"); t.innerHTML = html;
      const next = t.content.querySelector<HTMLElement>("[data-next]");
      t.content.querySelectorAll("[data-next]").forEach((n) => n.remove());
      watch(t.content); grid.append(t.content);
      more.dataset.feedMore = next?.dataset.next ?? "";
      if (!more.dataset.feedMore) more.remove();
    } finally { busy = false; }
  }, { rootMargin: "800px" }).observe(more);
}

// ── remember the city the buyer searched in ──
const city = document.querySelector<HTMLInputElement>("#feed-city");
if (city) {
  try { if (!city.value) city.value = localStorage.getItem("nc-city") ?? ""; } catch { /* private mode */ }
  city.form?.addEventListener("submit", () => { try { localStorage.setItem("nc-city", city.value); } catch { /* ignore */ } });
}
