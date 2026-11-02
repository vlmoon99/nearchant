// Any NEAR wallet (ADR 0022): NEAR Wallet Selector with Meteor, HOT, HERE, Intear, MyNearWallet, Sender, OKX,
// NEAR Mobile and Bitte, behind our own small chooser (no React). Loaded on demand from app.js: the page asks for a
// NEP-413 signature of a one-time message; browser wallets answer here, redirect wallets come back to callbackUrl.
import { Buffer } from "buffer";
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
import { setupWalletSelector, type ModuleState, type WalletSelector } from "@near-wallet-selector/core";
import { setupBitteWallet } from "@near-wallet-selector/bitte-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNearMobileWallet } from "@near-wallet-selector/near-mobile-wallet";
import { setupOKXWallet } from "@near-wallet-selector/okx-wallet";
import { setupSender } from "@near-wallet-selector/sender";

export interface SignRequest { message: string; recipient: string; nonce: Uint8Array; callbackUrl: string }
export interface Signed { accountId: string; publicKey: string; signature: string }

let selector: Promise<WalletSelector> | null = null;
const getSelector = (network: string) => (selector ??= setupWalletSelector({
  network: network === "mainnet" ? "mainnet" : "testnet",
  modules: [setupMeteorWallet(), setupHotWallet(), setupHereWallet(), setupIntearWallet(), setupMyNearWallet(), setupSender(), setupOKXWallet(), setupNearMobileWallet(), setupBitteWallet()],
}));

const css = `.ncw-back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:1000}
@media(min-width:640px){.ncw-back{align-items:center}}
.ncw{background:#fff;color:#1d1d1f;width:100%;max-width:420px;border-radius:20px 20px 0 0;padding:20px 16px 24px;font:15px/1.3 Inter,-apple-system,system-ui,sans-serif;max-height:85vh;overflow:auto}
@media(min-width:640px){.ncw{border-radius:20px}}
.ncw h2{font-size:20px;margin:0 0 4px}.ncw p{color:#6e6e73;font-size:13px;margin:0 0 14px}
.ncw button.w{display:flex;align-items:center;gap:12px;width:100%;padding:12px;border:1px solid #e5e5ea;border-radius:14px;background:#fff;margin:0 0 8px;cursor:pointer;font:inherit;text-align:left}
.ncw button.w:hover{background:#f5f5f7}.ncw img{width:32px;height:32px;border-radius:8px}.ncw small{color:#6e6e73;display:block;font-size:12px}
.ncw .x{float:right;border:0;background:none;font-size:22px;cursor:pointer;color:#6e6e73}.ncw output{display:block;font-size:13px;margin-top:8px;color:#c0392b}`;

/** Shows the chooser and asks the picked wallet to sign. Resolves with the signature, or null when the wallet
 *  redirects away (the answer then arrives at callbackUrl) or the person closes the chooser. */
export async function signWithWallet(network: string, req: SignRequest, title = "Choose your NEAR wallet"): Promise<Signed | null> {
  const sel = await getSelector(network);
  const modules = sel.store.getState().modules.filter((m: ModuleState) => !m.metadata.deprecated);
  if (!document.getElementById("ncw-css")) { const st = document.createElement("style"); st.id = "ncw-css"; st.textContent = css; document.head.append(st); }
  return new Promise((resolve) => {
    const back = document.createElement("div"); back.className = "ncw-back";
    const box = document.createElement("div"); box.className = "ncw"; back.append(box);
    box.innerHTML = `<button class="x" aria-label="Close">×</button><h2></h2><p>Your wallet signs a one-time message — no transaction, no fee.</p><div class="list"></div><output></output>`;
    box.querySelector("h2")!.textContent = title;
    const out = box.querySelector("output")!, list = box.querySelector(".list")!;
    const close = (v: Signed | null) => { back.remove(); resolve(v); };
    box.querySelector(".x")!.addEventListener("click", () => close(null));
    back.addEventListener("click", (e) => { if (e.target === back) close(null); });
    for (const m of modules) {
      const b = document.createElement("button"); b.className = "w"; b.type = "button";
      const img = document.createElement("img"); img.src = m.metadata.iconUrl; img.alt = "";
      img.onerror = () => { const ph = document.createElement("span"); ph.textContent = m.metadata.name.slice(0, 1); ph.style.cssText = "width:32px;height:32px;border-radius:8px;background:#f5f5f7;display:inline-flex;align-items:center;justify-content:center;font-weight:700;flex:none"; img.replaceWith(ph); };
      const name = document.createElement("span"); name.textContent = m.metadata.name;
      const note = document.createElement("small"); note.textContent = m.type === "injected" && !m.metadata.available ? "Browser extension — not installed here" : m.type === "browser" ? "Opens the wallet website" : m.type === "bridge" ? "Phone app (scan a QR code)" : "";
      name.append(note); b.append(img, name); list.append(b);
      b.addEventListener("click", async () => {
        if (m.type === "injected" && !m.metadata.available) { const dl = (m.metadata as { downloadUrl?: string }).downloadUrl; if (dl) window.open(dl, "_blank", "noopener"); return; }
        out.textContent = `Waiting for ${m.metadata.name}…`;
        try {
          const w = await sel.wallet(m.id);
          const params = { message: req.message, recipient: req.recipient, nonce: Buffer.from(req.nonce), callbackUrl: req.callbackUrl };
          let r = await w.signMessage(params).catch(async (err: Error) => {
            // Some wallets sign only for a connected account: connect (no access key), then sign.
            if (!/sign.?in|connect|account/i.test(err.message)) throw err;
            await (w as unknown as { signIn: (p: object) => Promise<unknown> }).signIn({ contractId: "", methodNames: [], accounts: [] });
            return w.signMessage(params);
          });
          if (!r) return close(null); // redirecting
          close({ accountId: r.accountId, publicKey: String(r.publicKey), signature: typeof r.signature === "string" ? r.signature : Buffer.from(r.signature as unknown as Uint8Array).toString("base64") });
        } catch (err) { out.textContent = `${m.metadata.name}: ${(err as Error).message.slice(0, 160)}`; }
      });
    }
    document.body.append(back);
  });
}
