// Buyer side of the card and order pages. Testnet: the buyer's key lives in this browser (localStorage) and the
// gateway sponsors its implicit account with test money (ADR 0001). Mainnet uses a wallet instead.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { fmtUnits, mountUi, sheet, tokenBalance, type Step } from "./ui-bits.js";

interface PageConfig { base: string; rpcUrl: string; orders: string; network: string; token?: { contract: string; symbol: string; decimals: number } }
const cfg: PageConfig = JSON.parse(document.getElementById("nc-config")!.textContent!);
const KEY = `nc:${cfg.network}:buyer-key`;

function buyerKey(): KeyPair {
  let s: string | null = null;
  try { s = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  if (s) return KeyPair.fromString(s as KeyPairString);
  const k = KeyPair.fromRandom("ed25519");
  try { localStorage.setItem(KEY, k.toString()); } catch { /* keep in memory only */ }
  return k;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(cfg.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
  return j as T;
}

/** The test wallet's account id: NEAR's implicit account of its key (hex of the public key), worked out here. */
const implicitOf = (key: KeyPair) => Array.from(key.getPublicKey().data, (b) => b.toString(16).padStart(2, "0")).join("");
/** Network failures in words (Safari says "Load failed", Chrome "Failed to fetch"). */
const plain = (e: unknown) => { const m = (e as Error).message ?? String(e); return /load failed|failed to fetch|networkerror|network request failed/i.test(m) ? "Couldn't reach NEAR or Nearchant — check your connection and try again." : m; };

/** The wallet that paid, for actions on an existing order: no server call (it used to ask the sponsor endpoint,
 *  which spent up to 30 s on a faucet call the buyer didn't need — and failed the button when the relayer was low). */
function payingAccount(): Account | null {
  let s: string | null = null;
  try { s = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  if (!s) return null;
  const key = KeyPair.fromString(s as KeyPairString);
  return new Account(implicitOf(key), new JsonRpcProvider({ url: cfg.rpcUrl }), new KeyPairSigner(key));
}

async function buyerAccount(): Promise<Account> {
  const key = buyerKey();
  const { accountId } = await post<{ accountId: string }>("public/buyers", { publicKey: key.getPublicKey().toString() });
  return new Account(accountId, new JsonRpcProvider({ url: cfg.rpcUrl }), new KeyPairSigner(key));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hex sha256 of fields joined by newlines — what a seller signs alongside the action (security review M4). */
async function bodyHash(...fields: string[]): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fields.join("\n")));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function signAs(key: KeyPair, action: string, handle: string, hash?: string): { message: string; signature: string; publicKey: string } {
  const message = `nearchant:${action}:${handle}:${Date.now()}${hash ? `:${hash}` : ""}`;
  const signature = btoa(String.fromCharCode(...key.sign(new TextEncoder().encode(message)).signature));
  return { message, signature, publicKey: key.getPublicKey().toString() };
}

interface CreatedOrder {
  orderId: string;
  amount: string;
  amountDisplay: string;
  payment: { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto: string; gasTgas: number };
  anyChainQuote?: { amountInFormatted: string; label: string } | null;
}

async function pay(form: HTMLFormElement) {
  const out = form.querySelector("output")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  out.classList.remove("hidden"); out.dataset.tone = "";
  try {
    const val = (n: string) => ((form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "").trim();
    // A store item asks how to reach the buyer: check it here first, so nobody waits for a wallet to hear "add a phone".
    const contact = form.elements.namedItem("name") ? { name: val("name"), phone: val("phone"), app: val("app"), email: val("email"), address: val("address") } : undefined;
    if (contact && !contact.phone && !contact.email) { out.dataset.tone = "bad"; out.textContent = "Add a phone number or an email, so the store can reach you."; (form.elements.namedItem("phone") as HTMLInputElement).focus(); button.disabled = false; return; }
    out.textContent = "Setting up your test wallet…";
    const account = await buyerAccount();
    out.textContent = "Creating order…";
    const order = await post<CreatedOrder>("public/orders", { serviceId: form.dataset.service, brief: val("brief"), option: val("option") || undefined, contact, buyerAccountId: account.accountId });
    const quote = order.anyChainQuote ? `\n(From another chain via NEAR Intents: about ${order.anyChainQuote.amountInFormatted} ${order.anyChainQuote.label}.)` : "";
    out.textContent = `Paying ${order.amountDisplay} into escrow…${quote}`;
    await account.callFunction({
      contractId: order.payment.receiverId, methodName: order.payment.methodName, args: order.payment.args,
      deposit: BigInt(order.payment.depositYocto), gas: BigInt(order.payment.gasTgas) * 10n ** 12n,
    });
    out.textContent = "Paid. Waiting for the chain to confirm…";
    for (let i = 0; i < 30; i++) {
      const s = await (await fetch(`${cfg.base}public/orders/${order.orderId}`)).json();
      if (s.state !== "awaiting_payment") break;
      await sleep(2000);
    }
    location.href = `${cfg.base}o/${order.orderId}`;
  } catch (e) {
    out.dataset.tone = "bad";
    out.textContent = `Could not complete: ${(e as Error).message}`;
    button.disabled = false;
  }
}


// ── Store item checkout (ADR 0026, 8 Nov): check the form here, then a sheet walks through the payment step by step
// and ends with a clear "Paid ✓" (or what went wrong and that the money stayed in the wallet). ─────────────────
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** The test wallet of this browser, only if one was already made (a page view never creates one). */
function existingWallet(): string | null {
  try { const s = localStorage.getItem(KEY); return s ? hex(KeyPair.fromString(s as KeyPairString).getPublicKey().data) : null; } catch { return null; }
}
async function showBalance(accountId: string | null): Promise<bigint | null> {
  const pill = document.querySelector<HTMLElement>("[data-pay-wallet]");
  if (!pill || !accountId || !cfg.token) return null;
  const b = await tokenBalance(cfg.rpcUrl, cfg.token.contract, accountId);
  if (b === null) return null;
  pill.querySelector("[data-pay-balance]")!.textContent = `${fmtUnits(b, cfg.token.decimals)} ${cfg.token.symbol}`;
  pill.title = `Test wallet ${accountId.slice(0, 6)}…${accountId.slice(-4)} in this browser — it pays at checkout`;
  pill.classList.remove("hidden");
  return b;
}
void showBalance(existingWallet());

/** Marks what is missing right at the field and says it in one line; true when the form can go. */
function checkForm(form: HTMLFormElement, out: HTMLElement): boolean {
  form.querySelectorAll(".invalid").forEach((x) => x.classList.remove("invalid"));
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement | HTMLTextAreaElement | null;
  const val = (n: string) => (field(n)?.value ?? "").trim();
  const problems: [string, string][] = [];
  const brief = field("brief");
  if (brief?.required && val("brief").length < 2) problems.push(["brief", "Answer the store's question"]);
  if (val("name").length < 2) problems.push(["name", "Add your name"]);
  const phone = val("phone").replace(/[\s().-]/g, "");
  if (!phone && !val("email")) problems.push(["phone", "Add a phone number or an email"]);
  else {
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) problems.push(["phone", "Write the phone with the country code, like +1 212 555 0100"]);
    if (val("email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val("email"))) problems.push(["email", "Check the email"]);
  }
  if (field("address") && val("address").length < 8) problems.push(["address", "Add the delivery address"]);
  if (!problems.length) { out.classList.add("hidden"); return true; }
  for (const [n] of problems) field(n)?.closest(".list-field")?.classList.add("invalid");
  out.classList.remove("hidden"); out.dataset.tone = "bad";
  out.textContent = problems.map(([, m]) => m).join(" · ");
  const first = field(problems[0]![0]);
  first?.focus(); first?.scrollIntoView({ block: "center", behavior: "smooth" });
  return false;
}

/** NEAR / network errors in words a buyer can act on. */
function payError(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/NotEnoughBalance|not enough balance|exceeds balance|insufficient/i.test(m)) return "Your test wallet doesn't have enough nUSD for this.";
  if (/fetch|network|Failed to fetch|timeout|ETIMEDOUT|503|502/i.test(m)) return "Couldn't reach NEAR just now. Check your connection and try again.";
  if (/too many/i.test(m)) return m;
  return m.length > 160 ? `${m.slice(0, 160)}…` : m;
}

async function payItem(form: HTMLFormElement): Promise<void> {
  const out = form.querySelector("output")!;
  if (!checkForm(form, out)) return;
  const val = (n: string) => ((form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "").trim();
  const contact = { name: val("name"), phone: val("phone"), app: val("app"), email: val("email"), address: val("address") };
  const price = form.dataset.price ?? "", store = form.dataset.store ?? "The store";
  const names = ["Getting your test wallet ready", "Creating your order", `Paying ${price} into escrow on NEAR`, "NEAR confirms the payment"];
  let at = 0, paidTx = false;
  const steps = (bad = false): Step[] => names.map((label, i) => ({ label, state: i < at ? "done" : i === at ? (bad ? "bad" : "now") : "todo" }));
  const w = sheet("Paying…", `${price} to ${store}. Keep this window open.`);
  const draw = (sub: string) => w.set("Paying…", sub, { steps: steps(), icon: "busy" });
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  try {
    draw(`${price} to ${store}. Keep this window open.`);
    const account = await buyerAccount();
    const bal = await showBalance(account.accountId);
    at = 1; draw(bal !== null && cfg.token ? `From your test wallet · balance ${fmtUnits(bal, cfg.token.decimals)} ${cfg.token.symbol}` : `${price} to ${store}.`);
    const order = await post<CreatedOrder>("public/orders", { serviceId: form.dataset.service, brief: val("brief"), option: val("option") || undefined, contact, buyerAccountId: account.accountId });
    if (bal !== null && BigInt(order.amount) > bal) throw new Error("NotEnoughBalance");
    at = 2; draw(`${order.amountDisplay} goes into escrow, not to the store yet.`);
    await account.callFunction({
      contractId: order.payment.receiverId, methodName: order.payment.methodName, args: order.payment.args,
      deposit: BigInt(order.payment.depositYocto), gas: BigInt(order.payment.gasTgas) * 10n ** 12n,
    });
    paidTx = true;
    // Kept in this browser, so "My orders" lists it even without signing in.
    try {
      const k = `nc:${cfg.network}:orders`, all = JSON.parse(localStorage.getItem(k) ?? "[]") as unknown[];
      localStorage.setItem(k, JSON.stringify([{ orderId: order.orderId, handle: form.dataset.handle ?? "", title: form.dataset.title ?? "Order", store, amount: order.amountDisplay, at: new Date().toISOString() }, ...all].slice(0, 50)));
    } catch { /* private mode: the order page link still works */ }
    at = 3; draw("Almost done — NEAR is recording it.");
    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      const s = await fetch(`${cfg.base}public/orders/${order.orderId}`).then((r) => r.json()).catch(() => null) as { state?: string } | null;
      confirmed = !!s && s.state !== "awaiting_payment";
      if (!confirmed) await sleep(2000);
    }
    void showBalance(account.accountId);
    const reach = contact.phone ? `${contact.app === "sms" ? "by text" : `on ${form.querySelector<HTMLSelectElement>("select[name=app] option:checked")?.textContent ?? contact.app}`} ${contact.phone}` : `at ${contact.email}`;
    const orderUrl = `${cfg.base}o/${order.orderId}`;
    if (confirmed) {
      at = 4;
      w.set("Paid ✓", `${order.amountDisplay} is safe in escrow on NEAR. ${store} gets it only when you confirm you received your order.\n\n${store} will contact you ${reach}.\n\nIt's saved in My orders.`, { steps: steps(), icon: "ok", buttons: [{ label: "Open my order", primary: true, href: orderUrl }, { label: "Keep shopping", onClick: () => { w.close(); } }] });
    } else {
      w.set("Payment sent", "NEAR is taking longer than usual to confirm it. Your order page updates by itself.", { steps: steps(), icon: "busy", buttons: [{ label: "Open my order", primary: true, href: orderUrl }] });
    }
  } catch (e) {
    w.set("Payment didn't go through", `${payError(e)}${paidTx ? "" : "\n\nNo money left your wallet."}`, { steps: steps(true), icon: "bad", buttons: [{ label: "Try again", primary: true, onClick: () => { w.close(); void payItem(form); } }, { label: "Close" }] });
  } finally {
    button.disabled = false;
  }
}

for (const form of document.querySelectorAll<HTMLFormElement>("form.order")) {
  // Store items (they ask for a contact) get the sheet; the classic deck card keeps its inline status line.
  form.addEventListener("submit", (e) => { e.preventDefault(); void (form.elements.namedItem("name") ? payItem(form) : pay(form)); });
  form.addEventListener("input", (e) => (e.target as HTMLElement).closest(".list-field")?.classList.remove("invalid"));
}

// Order page: Accept / Request revision / Request refund, signed by the buyer key that paid.
for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-order-action]")) {
  b.addEventListener("click", async () => {
    const out = document.querySelector<HTMLElement>("#order-msg")!;
    out.classList.remove("hidden"); out.dataset.tone = ""; out.textContent = "Preparing…";
    b.disabled = true;
    try {
      // Only the wallet that paid can confirm or ask for a refund. It lives in the browser where the order was paid.
      const account = payingAccount();
      const paidBy = b.closest<HTMLElement>("[data-order-buyer]")?.dataset.orderBuyer;
      if (!account || (paidBy && account.accountId !== paidBy)) {
        out.dataset.tone = "bad"; b.disabled = false;
        out.textContent = "This order was paid from a test wallet in another browser (or on the store's own address). Open this page there to confirm or ask for a refund. If you can't, the payment is released to the store automatically after the deadline — or contact the store.";
        return;
      }
      if (b.dataset.orderAction === "request_revision") {
        const note = document.querySelector<HTMLTextAreaElement>("#revision-note")?.value.trim() ?? "";
        if (note.length < 3) { out.dataset.tone = "bad"; out.textContent = "Say briefly what should change."; b.disabled = false; return; }
        const r = await fetch(`${cfg.base}public/orders/${b.dataset.order}/revision-note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) });
        if (!r.ok) { out.dataset.tone = "bad"; out.textContent = (await r.json()).error ?? "Could not save the note"; b.disabled = false; return; }
      }
      out.classList.remove("hidden");
      out.textContent = "Signing with your test wallet…";
      const before = await chainOf(b.dataset.order!);
      await account.callFunction({ contractId: cfg.orders, methodName: b.dataset.orderAction!, args: { order_id: b.dataset.order }, gas: 100n * 10n ** 12n });
      // Wait until NEAR shows the new state, then show it (no blind reload).
      for (let i = 0; i < 30; i++) {
        out.textContent = `Recorded — waiting for NEAR to confirm… ${i * 2} s`;
        if ((await chainOf(b.dataset.order!)) !== before) break;
        await sleep(2000);
      }
      out.textContent = "Done ✓"; out.dataset.tone = "ok";
      location.reload();
    } catch (e) {
      out.dataset.tone = "bad";
      out.textContent = `Could not complete: ${plain(e)}`;
      b.disabled = false;
    }
  });
}

// While the agents work, refresh the order page.
if (document.querySelector("[data-poll-order]")) setTimeout(() => location.reload(), 8000);

/** The order's money state on NEAR, as the store gateway reads it. */
async function chainOf(id: string): Promise<string | null> {
  const r = await fetch(`${cfg.base}public/orders/${id}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  return (r as { chainStatus?: string } | null)?.chainStatus ?? null;
}
// Store item order page: follow the order on NEAR (the store ships, approves a refund…) and show the new state
// as soon as it changes — a light JSON check, the page reloads only on a change. Stops after 30 minutes.
const liveBuyer = document.querySelector<HTMLElement>("[data-live-buyer]");
if (liveBuyer) {
  const id = liveBuyer.dataset.liveBuyer!, was = liveBuyer.dataset.chain ?? "";
  const t0 = Date.now();
  const tick = async (): Promise<void> => {
    if (document.visibilityState === "visible") {
      const now = await chainOf(id);
      if (now && now !== "unknown" && now !== was && !(was === "" && now === "not_found")) { location.reload(); return; }
    }
    if (Date.now() - t0 < 30 * 60_000) { await sleep(Date.now() - t0 < 120_000 ? 3000 : 8000); return tick(); }
  };
  void tick();
}

// "Create your shop": the owner key is made here and never leaves this browser (except as the user's download).
const shopForm = document.querySelector<HTMLFormElement>("#new-shop");
if (shopForm) {
  const handleInput = shopForm.elements.namedItem("handle") as HTMLInputElement;
  const hint = document.querySelector<HTMLElement>("#handle-hint")!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  handleInput.addEventListener("input", () => {
    clearTimeout(timer);
    const h = handleInput.value.trim();
    hint.textContent = h ? `becomes ${h}.nearchant.${cfg.network}` : "";
    timer = setTimeout(async () => {
      if (!/^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(h)) return;
      const r = await (await fetch(`/api/handles/${h}`)).json();
      hint.textContent = r.available ? `✓ ${h}.nearchant.${cfg.network} is free` : `✗ ${h} is taken or reserved`;
    }, 300);
  });
  shopForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = shopForm.querySelector("output")!;
    const button = shopForm.querySelector("button")!;
    button.disabled = true;
    const val = (n: string) => (shopForm.elements.namedItem(n) as HTMLInputElement).value.trim();
    const handle = val("handle");
    const key = KeyPair.fromRandom("ed25519");
    try { localStorage.setItem(`nc:${cfg.network}:shop:${handle}`, key.toString()); } catch { /* download below */ }
    try {
      out.textContent = "Creating your NEAR account and shop…";
      const r = await post<{ accountId: string; cardUrl: string }>("api/shops", { handle, ownerPublicKey: key.getPublicKey().toString(), name: val("name"), bio: val("bio"), price: Number(val("price")) });
      out.textContent = "Funding your agents' inference balance (10 test nUSD)…";
      const account = new Account(r.accountId, new JsonRpcProvider({ url: cfg.rpcUrl }), new KeyPairSigner(key));
      await account.callFunction({
        contractId: `nusd.${r.accountId.split(".").slice(1).join(".")}`, methodName: "ft_transfer_call",
        args: { receiver_id: `billing.${r.accountId.split(".").slice(1).join(".")}`, amount: "10000000", msg: JSON.stringify({ action: "top_up" }) },
        deposit: 1n, gas: 100n * 10n ** 12n,
      }).catch(() => { /* the shop works without it; the dashboard can top up later */ });
      const a = document.createElement("a");
      a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`${r.accountId}\n${key.toString()}\n`)}`;
      a.download = `${r.accountId}-key.txt`;
      a.textContent = "Download your account key";
      out.textContent = `Done: ${r.accountId}. `;
      out.append(a, document.createTextNode(" — then "));
      const go = document.createElement("a");
      go.href = r.cardUrl;
      go.textContent = "open your shop →";
      out.append(go);
    } catch (err) {
      out.textContent = `Could not create the shop: ${(err as Error).message}`;
      button.disabled = false;
    }
  });
}

// Manage page: connect a Telegram bot, authorised by a signature from the shop's own account key.
const tgForm = document.querySelector<HTMLFormElement>("#tg-connect");
if (tgForm) {
  const handle = tgForm.dataset.handle!;
  const keyInput = tgForm.elements.namedItem("key") as HTMLInputElement;
  try { keyInput.value = localStorage.getItem(`nc:${cfg.network}:shop:${handle}`) ?? ""; } catch { /* paste it */ }
  tgForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = tgForm.querySelector("output")!;
    try {
      const key = KeyPair.fromString(keyInput.value.trim() as KeyPairString);
      const token = (tgForm.elements.namedItem("token") as HTMLInputElement).value.trim();
      const signed = signAs(key, "telegram", handle, await bodyHash(token));
      out.textContent = "Connecting…";
      const r = await fetch(`/api/shops/${handle}/telegram`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...signed }) });
      const j = await r.json();
      out.textContent = r.ok ? `Connected: @${j.bot}. Open it in Telegram and send /start.` : `Could not connect: ${j.error}`;
    } catch (err) {
      out.textContent = `Could not connect: ${(err as Error).message}`;
    }
  });
}

// Manage page: connect the NEAR AI Agent Market (token + a webhook secret generated here), signed by the shop key.
const marketForm = document.querySelector<HTMLFormElement>("#market-connect");
if (marketForm) {
  const handle = marketForm.dataset.handle!;
  marketForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = marketForm.querySelector("output")!;
    try {
      const keyText = (document.querySelector<HTMLInputElement>("#tg-connect input[name=key]")?.value ?? "").trim();
      const key = KeyPair.fromString(keyText as KeyPairString);
      const webhookSecret = `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const token = (marketForm.elements.namedItem("token") as HTMLInputElement).value.trim();
      const signed = signAs(key, "market", handle, await bodyHash(token, webhookSecret));
      const r = await fetch(`/api/shops/${handle}/market`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, webhookSecret, ...signed }) });
      const j = await r.json();
      out.textContent = r.ok ? `Connected. In the market, set webhook URL ${j.webhookUrl} and secret ${webhookSecret} (shown once).` : `Could not connect: ${j.error}`;
    } catch (err) {
      out.textContent = `Could not connect: ${(err as Error).message} (the account key field above must be filled)`;
    }
  });
}

// Manage page: the dashboard (balances, orders) is fetched with a signature from the shop key (security review H3).
const dash = document.querySelector<HTMLElement>("#dashboard");
if (dash) {
  const handle = dash.dataset.handle!;
  const body = document.querySelector<HTMLElement>("#dashboard-body")!;
  const load = async () => {
    const keyText = (document.querySelector<HTMLInputElement>("#tg-connect input[name=key]")?.value ?? "").trim();
    if (!keyText) { body.textContent = "Paste your account key in the Telegram form below, then try again."; return; }
    try {
      const signed = signAs(KeyPair.fromString(keyText as KeyPairString), "dashboard", handle);
      const r = await fetch(`/api/shops/${handle}/dashboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
      const j = await r.json();
      if (!r.ok) { body.textContent = j.error; return; }
      const t = document.createElement("table");
      t.className = "stats";
      const row = (...cells: (string | Node)[]) => { const tr = t.insertRow(); for (const c of cells) tr.insertCell().append(c); };
      if (j.stats) {
        row("Wallet", j.stats.wallet, "payouts from accepted orders land here");
        if (j.stats.billing) row("Inference balance", j.stats.billing.balance, `spent today ${j.stats.billing.spentToday}, this month ${j.stats.billing.spentMonth}`);
        if (j.stats.campaign) row("Hiring budget", `${j.stats.campaign.left} left`, `auto up to ${j.stats.campaign.autoLimit} per hire, ${j.stats.campaign.dailyLimit} per day, only: ${j.stats.campaign.allowlist.join(", ") || "nobody"}`);
      }
      for (const o of j.orders) {
        const a = document.createElement("a");
        a.href = `/h/${handle}/o/${o.id}`;
        a.textContent = o.id.slice(0, 14) + "…";
        row(a, o.amount, `${o.state} · ${o.at}`);
      }
      body.replaceChildren(t);
    } catch (e) {
      body.textContent = `Could not load: ${(e as Error).message}`;
    }
  };
  document.querySelector("#dashboard-load")!.addEventListener("click", load);
  try { if (localStorage.getItem(`nc:${cfg.network}:shop:${handle}`)) void load(); } catch { /* manual */ }
}

// Segmented controls and copy buttons.
mountUi();
