// Buyer side of Nearchant (ADR 0022), on the feed, store and post pages: likes, reports, sign-in (email link or any
// NEAR wallet — the wallet chooser loads on demand from /assets/wallet.js), shorts that play when in view, and
// infinite scroll on the feed.
type Me = { id: string; email: string | null; wallet: string | null } | null;
const cfgEl = document.getElementById("nc-buyer");
const cfg = (cfgEl ? JSON.parse(cfgEl.textContent ?? "{}") : {}) as { network?: string; walletJs?: string; main?: string; mainPath?: string };
// On a store's own subdomain the buyer account (cookie) is not there: buyer actions continue on the main site.
if (cfg.main && cfg.mainPath && location.origin !== cfg.main) {
  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("[data-like],[data-report-post],[data-report-store],[data-follow],[data-buyer-me]");
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
const getMe = async (): Promise<Me> => (me !== undefined ? me : (me = await api<NonNullable<Me>>("/api/buyer/me").catch(() => null)));

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
      <button class="btn near" data-w>Use a NEAR wallet</button><span class="cap muted">Meteor, HOT, HERE, Intear, MyNearWallet and more — a one-time signed message, no fee.</span><output class="foot"></output>`);
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

// ── header: who is signed in ──
for (const el of document.querySelectorAll<HTMLElement>("[data-buyer-me]")) {
  void getMe().then((m) => {
    if (m) { el.textContent = m.email ?? m.wallet ?? "Signed in"; el.title = "Sign out"; el.addEventListener("click", async (e) => { e.preventDefault(); await api("/api/buyer/logout", {}); location.reload(); }); }
    else el.addEventListener("click", async (e) => { e.preventDefault(); if (await signInSheet("Like posts and get a feed that learns what you want.")) location.reload(); });
  });
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
