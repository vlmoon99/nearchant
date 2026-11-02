// Seller app + onboarding client (ADR 0018). The store's NEAR key is made and kept in this browser (testnet);
// the gateway sponsors the account. After one signature the session cookie carries the rest.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { toUnits } from "./units.js";

interface Cfg { base: string; rpcUrl: string; network: string; token: string; decimals: number; storeBase: string; page: string }
const cfg: Cfg = JSON.parse(document.getElementById("nc-config")!.textContent!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n) > n * 0.6 ? s.lastIndexOf(" ", n) : n).trimEnd()}…`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CUR = `nc:${cfg.network}:current-store`;
const keyOf = (h: string) => `nc:${cfg.network}:shop:${h}`;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const res = await fetch(path, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status, code: (j as { code?: string }).code });
  return j as T;
}

function sign(key: KeyPair, action: string, handle: string) {
  const message = `nearchant:${action}:${handle}:${Date.now()}`;
  const signature = btoa(String.fromCharCode(...key.sign(new TextEncoder().encode(message)).signature));
  return { message, signature, publicKey: key.getPublicKey().toString() };
}

/** Signs in with the key kept in this browser (or returns false when there is none). */
export async function signIn(handle: string): Promise<boolean> {
  const k = store.get(keyOf(handle));
  if (!k) return false;
  await api("/api/session", { handle, ...sign(KeyPair.fromString(k as KeyPairString), "session", handle) });
  return true;
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 24) || "store";
const storeUrl = (h: string) => (cfg.storeBase ? `https://${h}.${cfg.storeBase}` : `${location.origin}/h/${h}`);
const money = (units: string) => `${(Number(units) / 10 ** cfg.decimals).toLocaleString("en", { maximumFractionDigits: 2 })} ${cfg.token}`;

/** Resize to ≤1600 px JPEG in the browser: small uploads, no EXIF location. */
async function shrink(f: File): Promise<Blob> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.88));
}

// ---------------- onboarding ----------------
function onboarding() {
  const show = (step: string) => { $$("[data-step]").forEach((s) => s.classList.toggle("hidden", s.dataset.step !== step)); window.scrollTo(0, 0); };
  $$<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go!)));
  let handle = store.get(CUR) ?? "";

  // 2: kind + name → NEAR account + store + session + business
  let kind = "products";
  $$<HTMLLabelElement>("[data-kind]").forEach((o) => o.addEventListener("click", () => { kind = o.dataset.kind!; $$("[data-kind]").forEach((x) => x.classList.toggle("on", x === o)); }));
  const name = $<HTMLInputElement>("#store-name");
  name.addEventListener("input", () => { $("#store-link").textContent = `Your store link: ${storeUrl(slug(name.value)).replace(/^https?:\/\//, "")}`; });
  $("#create-store").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement, out = $("#sell-out");
    const n = name.value.trim();
    if (n.length < 2) { out.textContent = "Give your store a name (2+ letters)."; return; }
    btn.disabled = true;
    try {
      let h = slug(n);
      out.textContent = "Checking your store link…";
      for (let i = 0; i < 5 && !(await api<{ available: boolean }>(`/api/handles/${h}`)).available; i++) h = `${slug(n).slice(0, 20)}${Math.floor(10 + Math.random() * 89)}`;
      out.textContent = "Creating your NEAR account and store (about 10 seconds)…";
      const key = KeyPair.fromRandom("ed25519");
      store.set(keyOf(h), key.toString());
      await api("/api/shops", { handle: h, ownerPublicKey: key.getPublicKey().toString(), name: n, bio: "", price: 5 });
      store.set(CUR, h); handle = h;
      await signIn(h);
      await api("/api/app/business", { name: n, kind });
      out.textContent = "";
      show("show");
    } catch (err) { out.textContent = `Could not create the store: ${(err as Error).message}`; btn.disabled = false; }
  });

  // 3: description, link, photos → analyze
  const files: File[] = [];
  $<HTMLInputElement>("#photo-input").addEventListener("change", (e) => {
    for (const f of Array.from((e.target as HTMLInputElement).files ?? []).slice(0, 8 - files.length)) {
      files.push(f);
      const th = document.createElement("div"); th.className = "th"; th.style.backgroundImage = `url(${URL.createObjectURL(f)})`;
      $("#thumbs").insertBefore(th, $("#thumbs").lastElementChild);
    }
  });
  $("#analyze").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement, out = $("#show-out");
    if (!files.length) { out.textContent = "Add at least one photo of what you sell."; return; }
    btn.disabled = true;
    try {
      const me = await api<{ business: { name: string; kind: string } }>("/api/app/me");
      const link = $<HTMLInputElement>("#biz-link").value.trim();
      await api("/api/app/business", { name: me.business.name, kind: me.business.kind, description: $<HTMLTextAreaElement>("#biz-desc").value.trim(), links: link ? [link] : [] });
      out.textContent = "Uploading photos…";
      const fd = new FormData();
      for (const f of files) fd.append("photo", new File([await shrink(f)], f.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }));
      await api("/api/app/photos", fd);
      await api("/api/app/analyze", {});
      show("learn");
      void learn();
    } catch (err) { out.textContent = (err as Error).message; btn.disabled = false; }
  });

  // 4: facts appear as the worker finds them
  async function learn() {
    for (let i = 0; i < 200; i++) {
      const me = await api<{ business: { name: string }; profile: { status: string; facts: { title: string; detail: string }[]; error: string | null } }>("/api/app/me").catch(() => null);
      if (me) {
        $("#learn-title").textContent = `Getting to know ${me.business.name}…`;
        const f = me.profile.facts;
        const done = me.profile.status === "ready";
        $("#facts").innerHTML = f.map((x, j) => {
          const now = !done && j === f.length - 1 && me.profile.status === "finding";
          return `<div class="card" style="flex-direction:row;align-items:center;gap:12px;padding:14px${now ? ";opacity:.7" : ""}"><span class="dot ${now ? "now" : "ok"}">${now ? "…" : "✓"}</span><span class="stack" style="gap:2px"><span class="callout b">${esc(x.title)}</span><span class="foot muted">${esc(x.detail)}</span></span></div>`;
        }).join("") || `<div class="card" style="flex-direction:row;gap:12px;padding:14px"><span class="dot now">…</span><span class="callout b">Reading your photos</span></div>`;
        $("#learn-bar").style.width = `${done ? 100 : Math.min(90, 15 + f.length * 15)}%`;
        if (me.profile.status === "failed") { $("#learn-note").textContent = `Something went wrong: ${me.profile.error ?? "try again"}`; return; }
        if (done) { await sleep(700); return opportunities(); }
      }
      await sleep(2500);
    }
  }

  // 5: opportunities with honest estimates
  let chosen = new Set<string>();
  async function opportunities() {
    type Opp = { id: string; kind: string; title: string; why: string; estimateUnits: string; data: { action?: string } };
    let ops: Opp[] = [];
    for (let i = 0; i < 5; i++) {   // retried: one failed request must not leave the step empty
      const r = await api<{ opportunities: Opp[] }>("/api/app/opportunities").catch(() => null);
      if (r) { ops = r.opportunities; break; }
      await sleep(2000);
    }
    chosen = new Set(ops.map((o) => o.id));
    const color: Record<string, string> = { trend: "#FF9500", upsell: "#AF52DE", price: "#007AFF", channel: "#34C759" };
    const total = () => ops.filter((o) => chosen.has(o.id)).reduce((s, o) => s + Number(o.estimateUnits), 0);
    const paint = () => {
      $("#opp-count").textContent = String(ops.length || "a few");
      $("#opp-total").textContent = `≈ +${money(String(total()))} a month together`;
      $("#opps").innerHTML = ops.map((o) => `<div class="card" data-opp="${o.id}" style="gap:6px;padding:14px;cursor:pointer;${chosen.has(o.id) ? "" : "opacity:.55"}">
        <div class="spread"><span class="tag"><span style="color:${color[o.kind] ?? "#007AFF"}">●</span>${esc(o.kind[0]!.toUpperCase() + o.kind.slice(1))}</span><span class="row" style="gap:8px;align-items:center"><span class="foot b okt">+${esc(money(o.estimateUnits))}/mo</span><span class="chk ${chosen.has(o.id) ? "on" : ""}">${chosen.has(o.id) ? "✓" : ""}</span></span></div>
        <span class="callout b">${esc(o.title)}</span><span class="foot muted clamp2">${esc(o.why)}</span></div>`).join("") || `<p class="sub muted">No clear opportunities yet — we’ll keep looking. Let’s make your first posts.</p>`;
      $$("[data-opp]").forEach((el) => el.addEventListener("click", () => { const id = el.dataset.opp!; chosen.has(id) ? chosen.delete(id) : chosen.add(id); paint(); }));
    };
    paint();
    show("opps");
  }
  $("#make-posts").addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      await api("/api/app/opportunities/choose", { ids: [...chosen] });
      const r = await api<{ batchId: string; ids: string[] }>("/api/app/posts", { n: 3, opportunityIds: [...chosen] });
      show("posts");
      void watchPosts(r.batchId, r.ids);
    } catch (err) { btn.disabled = false; alert((err as Error).message); }
  });

  // 6: first posts appear as they are written and rendered
  async function watchPosts(batchId: string, ids: string[]) {
    for (let i = 0; i < 240; i++) {
      // A blip (deploy, network) must not stop the watch: the button would stay disabled forever.
      const res = await api<{ posts: { id: string; status: string; caption: string | null; imageUrl: string | null; idea: { angle?: string } }[] }>("/api/app/posts").catch(() => null);
      if (!res) { await sleep(3000); continue; }
      const { posts } = res;
      const mine = posts.filter((p) => ids.includes(p.id));
      $("#first-posts").innerHTML = mine.map((p) => `<div class="card" style="flex-direction:row;gap:12px;padding:12px;align-items:center">
        <div style="width:72px;height:72px;border-radius:12px;flex:none;background:var(--grouped) center/cover${p.imageUrl ? ` url('${p.imageUrl}?w=320')` : ""}"></div>
        <div class="stack" style="gap:6px;min-width:0"><span class="foot b clamp2">${esc(p.caption ?? (p.status === "failed" ? "Could not make this one" : "Writing…"))}</span><span class="cap muted clamp1">${esc(p.status === "ready" ? (p.idea?.angle ?? "Ready") : p.status === "failed" ? "skipped" : "AI is making it…")}</span></div></div>`).join("");
      const edit = document.querySelector<HTMLAnchorElement>("#edit-first"); if (edit) edit.href = `/app/posts?batch=${encodeURIComponent(batchId)}`;
      const ready = mine.filter((p) => p.status === "ready");
      const settled = mine.every((p) => ["ready", "failed"].includes(p.status));
      $("#posts-title").textContent = settled ? `Your first ${ready.length} posts are ready` : "Making your first posts…";
      const btn = $<HTMLButtonElement>("#schedule-all");
      btn.disabled = !settled || !ready.length;
      if (settled) {
        btn.onclick = async () => {
          btn.disabled = true;
          await api("/api/app/posts/choose", { batchId, keep: ready.map((p) => p.id) });
          for (const [k, p] of ready.entries()) await api(`/api/app/posts/${p.id}/schedule`, { at: nextSlot(k).toISOString() });
          live();
        };
        return;
      }
      await sleep(3000);
    }
  }

  // 7: the store is live
  function live() {
    const url = storeUrl(handle);
    const a = $<HTMLAnchorElement>("#store-url"); a.href = url; a.textContent = url.replace(/^https?:\/\//, "");
    $("#copy-link").onclick = () => void navigator.clipboard?.writeText(url);
    $<HTMLAnchorElement>("#share-tg").href = `https://t.me/share/url?url=${encodeURIComponent(url + "?ref=telegram")}`;
    $<HTMLAnchorElement>("#share-wa").href = `https://wa.me/?text=${encodeURIComponent(url + "?ref=whatsapp")}`;
    const acct = `${handle}.nearchant.${cfg.network === "mainnet" ? "near" : "testnet"}`;
    $("#near-account").textContent = acct;
    const k = store.get(keyOf(handle)) ?? "";
    const dl = $<HTMLAnchorElement>("#key-download"); dl.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`${acct}\n${k}\n`)}`; dl.download = `${acct}-key.txt`;
    show("live");
  }

  // Resume where the owner left off.
  void (async () => {
    if (!handle || !store.get(keyOf(handle))) return;
    try {
      const me = await api<{ business: unknown; profile: { status: string } | null }>("/api/app/me").catch(async (e) => { if ((e as { status?: number }).status === 401 && (await signIn(handle))) return api<{ business: unknown; profile: { status: string } | null }>("/api/app/me"); throw e; });
      if (!me.business) return show("sell");
      const st = me.profile?.status ?? "none";
      if (st === "none") return show("show");
      if (st === "analyzing" || st === "finding") { show("learn"); return void learn(); }
      if (st === "ready") return void opportunities();
    } catch { /* fresh start */ }
  })();
}

/** Posting slots: the next Friday 18:00 / Saturday 12:00 / Sunday 11:00 local (AI best-time defaults). */
function nextSlot(k: number): Date {
  const want = [[5, 18], [6, 12], [0, 11]][k % 3]!;
  const d = new Date();
  d.setHours(want[1]!, 0, 0, 0);
  while (d.getDay() !== want[0] || d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}

// ---------------- seller app pages ----------------
function sellerApp() {
  // Posts page: refresh while AI is still making posts.
  const r = document.querySelector<HTMLElement>("[data-refresh]");
  if (r) setTimeout(() => location.reload(), Number(r.dataset.refresh) || 4000);

  // Create: upload photos, pick an opportunity, create a batch.
  const input = document.querySelector<HTMLInputElement>("#create-photos");
  input?.addEventListener("change", async () => {
    const fd = new FormData();
    for (const f of Array.from(input.files ?? []).slice(0, 8)) fd.append("photo", new File([await shrink(f)], "photo.jpg", { type: "image/jpeg" }));
    try { await api("/api/app/photos", fd); location.reload(); } catch (e) { $("#create-out").textContent = (e as Error).message; }
  });
  let opp: string | null = document.querySelector<HTMLElement>("[data-opp-pick].on")?.dataset.oppPick ?? null;
  $$("[data-opp-pick]").forEach((el) => el.addEventListener("click", () => { opp = el.dataset.oppPick!; $$("[data-opp-pick]").forEach((x) => x.classList.toggle("on", x === el)); }));
  document.querySelector("#create-go")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
    try {
      const r = await api<{ batchId: string }>("/api/app/posts", { n: 3, opportunityIds: opp ? [opp] : [], about: document.querySelector<HTMLInputElement>("#create-about")?.value ?? "" });
      location.href = `/app/posts?batch=${encodeURIComponent(r.batchId)}`;
    } catch (err) { btn.disabled = false; $("#create-out").textContent = (err as { code?: string }).code === "quota_exceeded" ? "You used this month’s free posts. Pro gives 150 a month." : (err as Error).message; }
  });

  // Home: sell an AI-found product (set a price), mark an order shipped.
  $$("[data-add-item]").forEach((b) => b.addEventListener("click", async () => {
    const row = b.closest<HTMLElement>("[data-suggest]")!;
    const price = Number(row.querySelector<HTMLInputElement>("input")!.value);
    if (!(price > 0)) { row.querySelector<HTMLInputElement>("input")!.focus(); return; }
    try { await api("/api/app/items", { title: row.dataset.suggest, description: row.dataset.desc, price, photoMediaId: row.dataset.photo || null }); location.reload(); } catch (e) { alert((e as Error).message); }
  }));
  $$("[data-ship]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.ship!;
    try { await api(`/api/app/orders/${id}/ship`, { note: document.querySelector<HTMLInputElement>(`[data-ship-note="${id}"]`)?.value ?? "" }); location.reload(); } catch (e) { alert((e as Error).message); }
  }));

  // Analytics / settings / celebration.
  document.querySelector("#refresh-insights")?.addEventListener("click", async () => {
    $("#insights-out").textContent = "AI is reading your numbers…";
    await api("/api/app/insights", {}).catch((e) => { $("#insights-out").textContent = (e as Error).message; });
    setTimeout(() => location.reload(), 15000);
  });
  // No insights yet: ask for the first ones without waiting for a click (once per page view).
  if (document.querySelector("[data-auto-insights]")) {
    void api("/api/app/insights", {}).then(() => setTimeout(() => location.reload(), 20000)).catch(() => { $("#insights-out").textContent = "Click Refresh to try again."; });
  }
  document.querySelector("#dismiss-celebration")?.addEventListener("click", async () => { await api("/api/app/celebrated", {}).catch(() => {}); $("#celebration").remove(); });
  document.querySelector<HTMLFormElement>("#settings-store")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target as HTMLFormElement; const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
    try { await api("/api/app/business", { name: v("name"), kind: v("kind"), description: v("description"), links: v("link") ? [v("link")] : [] }); f.querySelector("output")!.textContent = "Saved ✓"; } catch (err) { f.querySelector("output")!.textContent = (err as Error).message; }
  });
  document.querySelector<HTMLFormElement>("#settings-brand")?.addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target as HTMLFormElement;
    try { await api("/api/app/profile/wishes", { wishes: (f.elements.namedItem("wishes") as HTMLTextAreaElement).value }); f.querySelector("output")!.textContent = "Saved ✓ — the next posts follow it"; } catch (err) { f.querySelector("output")!.textContent = (err as Error).message; }
  });
  document.querySelector("#export-key")?.addEventListener("click", (e) => {
    e.preventDefault(); const h = store.get(CUR); const k = h ? store.get(keyOf(h)) : null;
    if (!k) { alert("The store key is not in this browser."); return; }
    const a = document.createElement("a"); a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`${h}\n${k}\n`)}`; a.download = `${h}-near-key.txt`; a.click();
  });

  // Post detail: save caption, schedule.
  document.querySelector("#save-caption")?.addEventListener("click", async (e) => {
    const id = (e.currentTarget as HTMLElement).dataset.post!;
    try { await api(`/api/app/posts/${id}/caption`, { caption: $<HTMLTextAreaElement>("#caption").value }); $("#post-out").textContent = "Saved ✓"; } catch (err) { $("#post-out").textContent = (err as Error).message; }
  });
  $$("[data-rewrite]").forEach((b) => b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    try { await api(`/api/app/posts/${b.dataset.post}/rewrite`, { style: b.dataset.rewrite }); location.reload(); } catch (err) { alert((err as Error).message); (b as HTMLButtonElement).disabled = false; }
  }));
  $$("[data-make-video]").forEach((b) => b.addEventListener("click", async () => {
    (b as HTMLButtonElement).disabled = true;
    try { await api(`/api/app/posts/${b.dataset.makeVideo}/video`, {}); location.reload(); } catch (err) { alert((err as Error).message); (b as HTMLButtonElement).disabled = false; }
  }));
  $$("[data-schedule]").forEach((b) => b.addEventListener("click", async () => {
    const at = b.dataset.when === "now" ? new Date() : nextSlot(0);
    try { await api(`/api/app/posts/${b.dataset.schedule}/schedule`, { at: at.toISOString() }); location.reload(); } catch (err) { alert((err as Error).message); }
  }));
}

/** No session cookie: sign in with the store key kept in this browser, else go to onboarding. */
async function signinPage() {
  const h = store.get(CUR);
  if (h && (await signIn(h).catch(() => false))) { location.reload(); return; }
  const h1 = document.querySelector("h1"); if (h1) h1.textContent = "Sign in";
  $("#signin-msg").textContent = "No store key in this browser. Sign in with the NEAR wallet you linked, create a store, or open Nearchant in the browser where you made it.";
}

// ── Wallet: Receive / Withdraw (nUSD from the store account, signed here with the store key) ─────────────────────
async function rpcQuery<T>(params: Record<string, unknown>): Promise<T | null> {
  const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) }).then((x) => x.json()).catch(() => null);
  return r?.result ?? null;
}
const viewCall = async <T>(contract: string, method: string, args: unknown): Promise<T | null> => {
  const r = await rpcQuery<{ result: number[] }>({ request_type: "call_function", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return r ? JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T : null;
};
// "Share proof link": the public /verify page for this post (native share sheet on phones, else copy).
document.querySelectorAll<HTMLAnchorElement>("[data-share-proof]").forEach((a) => a.addEventListener("click", async (e) => {
  e.preventDefault();
  const url = new URL(a.dataset.shareProof!, location.origin).toString();
  try { if (navigator.share) await navigator.share({ title: a.dataset.shareTitle ?? "Proof on NEAR", url }); else { await navigator.clipboard.writeText(url); a.lastChild!.textContent = "Link copied"; } } catch { /* cancelled */ }
}));
document.querySelector<HTMLElement>("[data-receive]")?.addEventListener("click", () => $("#receive-card").classList.toggle("hidden"));
document.querySelectorAll<HTMLElement>("[data-copy]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); void navigator.clipboard?.writeText(b.dataset.copy!); b.textContent = "Copied"; }));
document.querySelector<HTMLElement>("[data-withdraw-open]")?.addEventListener("click", () => $("#withdraw-form").classList.toggle("hidden"));
document.querySelector<HTMLFormElement>("#withdraw-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget as HTMLFormElement, out = $("#withdraw-out"), btn = f.querySelector("button")!;
  const to = (f.elements.namedItem("to") as HTMLInputElement).value.trim().toLowerCase();
  const handle = store.get(CUR), key = handle ? store.get(keyOf(handle)) : null;
  if (!handle || !key) { out.textContent = "Your store key is not in this browser — open Nearchant where you made the store, or import the key."; return; }
  if (!cfg.tokenContract || !cfg.accountSuffix) { out.textContent = "Withdrawals are not set up on this server."; return; }
  btn.disabled = true;
  try {
    const units = toUnits((f.elements.namedItem("amount") as HTMLInputElement).value, cfg.decimals);
    if (units <= 0n) throw new Error("amount must be above 0");
    if (!(await rpcQuery({ request_type: "view_account", account_id: to }))) throw new Error(`${to} does not exist on NEAR ${cfg.network}`);
    const accountId = `${handle}.${cfg.accountSuffix}`;
    const bal = await viewCall<string>(cfg.tokenContract, "ft_balance_of", { account_id: accountId });
    if (bal === null) throw new Error("could not read the store balance from NEAR — try again in a moment");
    const balance = BigInt(bal);
    if (units > balance) throw new Error(`the store has ${money(String(balance))}`);
    const account = new Account(accountId, new JsonRpcProvider({ url: cfg.rpcUrl }), new KeyPairSigner(KeyPair.fromString(key as KeyPairString)));
    if (!(await viewCall(cfg.tokenContract, "storage_balance_of", { account_id: to }))) {
      out.textContent = `Registering ${to} with ${cfg.token}…`;
      await account.callFunction({ contractId: cfg.tokenContract, methodName: "storage_deposit", args: { account_id: to, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30n * 10n ** 12n });
    }
    out.textContent = `Sending ${money(String(units))} to ${to}…`;
    try {
      await account.callFunction({ contractId: cfg.tokenContract, methodName: "ft_transfer", args: { receiver_id: to, amount: units.toString(), memo: "Nearchant withdrawal" }, deposit: 1n, gas: 30n * 10n ** 12n });
    } catch (err) {
      // The transfer may have landed even though the answer was lost: never let a retry send it twice.
      const after = await viewCall<string>(cfg.tokenContract, "ft_balance_of", { account_id: accountId });
      if (after !== null && BigInt(after) <= balance - units) { out.textContent = `Sent ${money(String(units))} to ${to} on NEAR.`; setTimeout(() => location.reload(), 2500); return; }
      out.textContent = `Not sure the transfer went through (${(err as Error).message.slice(0, 120)}). Reload the page and check the balance before trying again.`;
      return; // button stays disabled
    }
    out.textContent = `Sent ${money(String(units))} to ${to} on NEAR.`;
    setTimeout(() => location.reload(), 2500);
  } catch (err) { out.textContent = (err as Error).message.slice(0, 200); btn.disabled = false; }
});

// ── NEAR wallet (NEP-413 sign message via MyNearWallet) ───────────────────────────────────────────────────────────
const WALLET = cfg.network === "mainnet" ? "https://app.mynearwallet.com" : "https://testnet.mynearwallet.com";
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
function walletGo(purpose: "link" | "signin") {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const req = { purpose, message: `nearchant:wallet:${purpose}:${Date.now()}`, nonce: b64(nonce), recipient: location.host, callbackUrl: `${location.origin}/app/wallet-connect`, back: location.pathname };
  sessionStorage.setItem("nc-wallet", JSON.stringify(req));
  const u = new URL("/sign-message", WALLET);
  u.searchParams.set("message", req.message); u.searchParams.set("nonce", req.nonce); u.searchParams.set("recipient", req.recipient); u.searchParams.set("callbackUrl", req.callbackUrl);
  location.href = u.toString();
}
document.querySelectorAll<HTMLElement>("[data-wallet]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); walletGo(b.dataset.wallet as "link" | "signin"); }));

async function walletConnectPage() {
  const msg = $("#wallet-msg");
  const req = JSON.parse(sessionStorage.getItem("nc-wallet") ?? "null") as { purpose: string; message: string; nonce: string; recipient: string; callbackUrl: string; back: string } | null;
  const q = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const accountId = q.get("accountId"), publicKey = q.get("publicKey"), signature = q.get("signature");
  if (!req || !accountId || !publicKey || !signature) { msg.textContent = q.get("error") ? `The wallet said: ${q.get("error")}` : "No signature came back from the wallet. Try again from Settings."; return; }
  sessionStorage.removeItem("nc-wallet");
  try {
    const r = await api<{ handle: string; linked?: string }>("/api/wallet/verify", { accountId, publicKey, signature, message: req.message, nonce: req.nonce, recipient: req.recipient, callbackUrl: req.callbackUrl });
    msg.textContent = r.linked ? `Linked ${r.linked} to your store.` : "Signed in.";
    location.href = r.linked ? "/app/settings#wallet" : "/app";
  } catch (err) { msg.textContent = (err as Error).message; }
}

if (cfg.page === "wallet-connect") void walletConnectPage();
if (cfg.page === "onboarding") onboarding();
if (cfg.page === "app") sellerApp();
if (cfg.page === "signin") void signinPage();
