// Buyer side of the card and order pages. Testnet: the buyer's key lives in this browser (localStorage) and the
// gateway sponsors its implicit account with test money (ADR 0001). Mainnet uses a wallet instead.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";

interface PageConfig { base: string; rpcUrl: string; orders: string; network: string }
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

async function buyerAccount(): Promise<Account> {
  const key = buyerKey();
  const { accountId } = await post<{ accountId: string }>("public/buyers", { publicKey: key.getPublicKey().toString() });
  return new Account(accountId, new JsonRpcProvider({ url: cfg.rpcUrl }), new KeyPairSigner(key));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CreatedOrder {
  orderId: string;
  amountDisplay: string;
  payment: { receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto: string; gasTgas: number };
  anyChainQuote?: { amountInFormatted: string; label: string } | null;
}

async function pay(form: HTMLFormElement) {
  const out = form.querySelector("output")!;
  const button = form.querySelector("button")!;
  button.disabled = true;
  try {
    out.textContent = "Setting up your test wallet…";
    const account = await buyerAccount();
    out.textContent = "Creating order…";
    const brief = (form.elements.namedItem("brief") as HTMLTextAreaElement).value;
    const order = await post<CreatedOrder>("public/orders", { serviceId: form.dataset.service, brief, buyerAccountId: account.accountId });
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
    out.textContent = `Could not complete: ${(e as Error).message}`;
    button.disabled = false;
  }
}

for (const form of document.querySelectorAll<HTMLFormElement>("form.order")) {
  form.addEventListener("submit", (e) => { e.preventDefault(); void pay(form); });
}

// Order page: Accept / Request revision / Request refund, signed by the buyer key that paid.
for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-order-action]")) {
  b.addEventListener("click", async () => {
    const out = document.querySelector<HTMLElement>("#order-msg")!;
    b.disabled = true;
    try {
      const account = await buyerAccount();
      out.textContent = "Signing…";
      await account.callFunction({ contractId: cfg.orders, methodName: b.dataset.orderAction!, args: { order_id: b.dataset.order }, gas: 100n * 10n ** 12n });
      out.textContent = "Done. Refreshing…";
      await sleep(1500);
      location.reload();
    } catch (e) {
      out.textContent = `Could not complete: ${(e as Error).message}`;
      b.disabled = false;
    }
  });
}

// While the agents work, refresh the order page.
if (document.querySelector("[data-poll-order]")) setTimeout(() => location.reload(), 8000);

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
