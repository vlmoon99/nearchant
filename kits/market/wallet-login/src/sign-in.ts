// Browser side: a small wallet chooser (no React) over NEAR Wallet Selector, asking the picked wallet to sign the
// server's challenge (NEP-413). No transaction, no fee. Browser-extension and app wallets answer here; redirect
// wallets (MyNearWallet) go away and come back to `callbackUrl` — call finishRedirectSignIn() on that page.
// Wallet libraries are imported on first use, so importing this kit on a server loads none of them.
import { Buffer } from "buffer";
import type { ModuleState, WalletModuleFactory, WalletSelector } from "@near-wallet-selector/core";
import { fromBase64 } from "./nep413.js";
import type { Challenge } from "./server.js";
import type { Network } from "./rpc.js";

/** What to POST to your server's verify endpoint. */
export interface SignedLogin {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
  nonce: string;
  recipient: string;
  callbackUrl: string | null;
}

export interface SignInOptions {
  network?: Network;
  /** From your server (createChallenge), or a function that fetches it. */
  challenge: Challenge | (() => Promise<Challenge>);
  /** Where redirect wallets come back to. Default: this page. */
  callbackUrl?: string;
  /** Wallet Selector modules. Default: Meteor, HOT, HERE, Intear, MyNearWallet, Sender. */
  modules?: WalletModuleFactory[];
  title?: string;
  /** sessionStorage key that remembers the challenge across a redirect. */
  storageKey?: string;
}

const KEY = "nearkit:wallet-login";

/** The default wallets, loaded on demand. */
export async function defaultModules(): Promise<WalletModuleFactory[]> {
  const [meteor, hot, here, intear, mnw, sender] = await Promise.all([
    import("@near-wallet-selector/meteor-wallet"), import("@near-wallet-selector/hot-wallet"), import("@near-wallet-selector/here-wallet"),
    import("@near-wallet-selector/intear-wallet"), import("@near-wallet-selector/my-near-wallet"), import("@near-wallet-selector/sender"),
  ]);
  // Some modules' factory types are narrower than the selector's; they work the same.
  return [meteor.setupMeteorWallet(), hot.setupHotWallet(), here.setupHereWallet(), intear.setupIntearWallet(), mnw.setupMyNearWallet(), sender.setupSender()] as WalletModuleFactory[];
}

let selector: Promise<WalletSelector> | null = null;
async function getSelector(network: Network, modules?: WalletModuleFactory[]): Promise<WalletSelector> {
  (globalThis as { Buffer?: unknown }).Buffer ??= Buffer; // wallet libraries expect Node's Buffer
  if (!selector) {
    selector = (async () => {
      const { setupWalletSelector } = await import("@near-wallet-selector/core");
      return setupWalletSelector({ network, modules: modules ?? (await defaultModules()) });
    })();
    selector.catch(() => { selector = null; });
  }
  return selector;
}

/**
 * Shows the chooser and asks the picked wallet to sign. Resolves with what to send to your server, or null when the
 * person closes the chooser or a redirect wallet takes over (the answer then arrives at callbackUrl).
 */
export async function signIn(o: SignInOptions): Promise<SignedLogin | null> {
  const network = o.network ?? "testnet";
  const ch = typeof o.challenge === "function" ? await o.challenge() : o.challenge;
  const callbackUrl = o.callbackUrl ?? location.href.split("#")[0]!;
  try { sessionStorage.setItem(o.storageKey ?? KEY, JSON.stringify({ ...ch, callbackUrl })); } catch { /* redirect wallets won't work */ }
  const sel = await getSelector(network, o.modules);
  const modules = sel.store.getState().modules.filter((m: ModuleState) => !m.metadata.deprecated);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "nwl-back";
    back.innerHTML = `<div class="nwl" role="dialog" aria-modal="true"><button type="button" class="nwl-x" aria-label="Close">×</button><h2></h2><p>Your wallet signs a one-time message — no transaction, no fee.</p><div class="nwl-list"></div><output></output></div>`;
    back.querySelector("h2")!.textContent = o.title ?? "Sign in with your NEAR wallet";
    const out = back.querySelector("output")!, list = back.querySelector(".nwl-list")!;
    const close = (v: SignedLogin | null) => { back.remove(); resolve(v); };
    back.querySelector(".nwl-x")!.addEventListener("click", () => close(null));
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    for (const m of modules) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "nwl-wallet";
      const img = document.createElement("img"); img.src = m.metadata.iconUrl; img.alt = "";
      img.onerror = () => { const ph = document.createElement("span"); ph.className = "nwl-ph"; ph.textContent = m.metadata.name.slice(0, 1); img.replaceWith(ph); };
      const name = document.createElement("span"); name.textContent = m.metadata.name;
      const note = document.createElement("small");
      note.textContent = m.type === "injected" && !m.metadata.available ? "Browser extension — not installed here" : m.type === "browser" ? "Opens the wallet website" : m.type === "bridge" ? "Phone app (scan a QR code)" : "";
      name.append(note); b.append(img, name); list.append(b);
      b.addEventListener("click", async () => {
        if (m.type === "injected" && !m.metadata.available) { const dl = (m.metadata as { downloadUrl?: string }).downloadUrl; if (dl) window.open(dl, "_blank", "noopener"); return; }
        out.textContent = `Waiting for ${m.metadata.name}…`;
        try {
          const w = await sel.wallet(m.id);
          if (!w.signMessage) throw new Error("this wallet can't sign messages");
          const params = { message: ch.message, recipient: ch.recipient, nonce: Buffer.from(fromBase64(ch.nonce)), callbackUrl };
          const r = await w.signMessage(params).catch(async (err: Error) => {
            // Some wallets sign only for a connected account: connect (no access key is added), then sign.
            if (!/sign(ed)?.?in|connect|account/i.test(err.message)) throw err;
            await (w as unknown as { signIn: (p: object) => Promise<unknown> }).signIn({ contractId: "", methodNames: [], accounts: [] });
            return w.signMessage!(params);
          });
          if (!r) return close(null); // redirecting
          const signature = typeof r.signature === "string" ? r.signature : Buffer.from(r.signature as unknown as Uint8Array).toString("base64");
          close({ accountId: r.accountId, publicKey: String(r.publicKey), signature, message: ch.message, nonce: ch.nonce, recipient: ch.recipient, callbackUrl });
        } catch (err) {
          out.textContent = `${m.metadata.name}: ${String((err as Error).message ?? err).slice(0, 160)}`;
        }
      });
    }
    document.body.append(back);
    (list.firstElementChild as HTMLElement | null)?.focus();
  });
}

/**
 * On the callbackUrl page after a redirect wallet: reads accountId/publicKey/signature from the URL (hash or
 * query) and the challenge remembered before leaving. null when nothing came back; `{ error }` when the wallet
 * reported one.
 */
export function finishRedirectSignIn(o: { storageKey?: string; url?: string } = {}): SignedLogin | { error: string } | null {
  const u = new URL(o.url ?? location.href);
  const q = new URLSearchParams(u.hash.slice(1) || u.search.slice(1));
  let saved: (Challenge & { callbackUrl: string }) | null = null;
  try { saved = JSON.parse(sessionStorage.getItem(o.storageKey ?? KEY) ?? "null"); sessionStorage.removeItem(o.storageKey ?? KEY); } catch { /* none */ }
  const accountId = q.get("accountId"), publicKey = q.get("publicKey"), signature = q.get("signature");
  if (q.get("error")) return { error: q.get("error")! };
  if (!saved || !accountId || !publicKey || !signature) return null;
  return { accountId, publicKey, signature, message: saved.message, nonce: saved.nonce, recipient: saved.recipient, callbackUrl: saved.callbackUrl };
}
