// @vitest-environment happy-dom
// The chooser and redirect handling, with Wallet Selector replaced by a fake wallet.
import { afterEach, describe, expect, it, vi } from "vitest";

const signMessage = vi.fn();
const signInFn = vi.fn();
vi.mock("@near-wallet-selector/core", () => ({
  setupWalletSelector: async () => ({
    store: { getState: () => ({ modules: [
      { id: "fake", type: "injected", metadata: { name: "Fake Wallet", iconUrl: "", available: true, deprecated: false } },
      { id: "missing", type: "injected", metadata: { name: "Not Installed", iconUrl: "", available: false, deprecated: false, downloadUrl: "https://get.example" } },
      { id: "old", type: "browser", metadata: { name: "Old", iconUrl: "", available: true, deprecated: true } },
    ] }) },
    wallet: async () => ({ signMessage, signIn: signInFn }),
  }),
}));

const { signIn, finishRedirectSignIn, createChallenge } = await import("../src/index.js");
afterEach(() => { document.body.innerHTML = ""; sessionStorage.clear(); signMessage.mockReset(); signInFn.mockReset(); });
const tick = () => new Promise((r) => setTimeout(r, 0));
const chooser = async () => { for (let i = 0; i < 50 && !document.querySelector(".nwl-wallet"); i++) await tick(); };
const walletButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".nwl-wallet")];

describe("signIn", () => {
  it("lists the wallets (not deprecated ones) and returns what the picked wallet signed", async () => {
    const ch = createChallenge({ recipient: "shop.example" });
    signMessage.mockResolvedValue({ accountId: "alice.testnet", publicKey: "ed25519:abc", signature: "c2ln" });
    const p = signIn({ challenge: ch, callbackUrl: "https://shop.example/cb", modules: [] });
    await chooser();
    expect(walletButtons().map((b) => b.querySelector("span")!.firstChild!.textContent)).toEqual(["Fake Wallet", "Not Installed"]);
    expect(walletButtons()[1]!.textContent).toContain("not installed here");
    walletButtons()[0]!.click();
    await expect(p).resolves.toEqual({ accountId: "alice.testnet", publicKey: "ed25519:abc", signature: "c2ln", message: ch.message, nonce: ch.nonce, recipient: "shop.example", callbackUrl: "https://shop.example/cb" });
    const params = signMessage.mock.calls[0]![0] as { nonce: Uint8Array; recipient: string; message: string };
    expect(Buffer.from(params.nonce).toString("base64")).toBe(ch.nonce);
    expect(params.recipient).toBe("shop.example");
    expect(document.querySelector(".nwl-back")).toBeNull();
  });

  it("connects first when a wallet signs only for a connected account", async () => {
    signMessage.mockRejectedValueOnce(new Error("Wallet not signed in")).mockResolvedValueOnce({ accountId: "a.testnet", publicKey: "ed25519:k", signature: "s" });
    const p = signIn({ challenge: async () => createChallenge({ recipient: "x.example" }), modules: [] });
    await chooser();
    walletButtons()[0]!.click();
    expect((await p)?.accountId).toBe("a.testnet");
    expect(signInFn).toHaveBeenCalledOnce();
  });

  it("shows a wallet error and stays open; closing resolves null", async () => {
    signMessage.mockRejectedValue(new Error("User rejected"));
    const p = signIn({ challenge: createChallenge({ recipient: "x.example" }), modules: [] });
    await chooser();
    walletButtons()[0]!.click();
    await tick(); await tick();
    expect(document.querySelector(".nwl output")!.textContent).toBe("Fake Wallet: User rejected");
    document.querySelector<HTMLButtonElement>(".nwl-x")!.click();
    await expect(p).resolves.toBeNull();
  });

  it("resolves null when a redirect wallet takes over, keeping the challenge for the way back", async () => {
    signMessage.mockResolvedValue(undefined);
    const ch = createChallenge({ recipient: "x.example" });
    const p = signIn({ challenge: ch, callbackUrl: "https://x.example/back", modules: [] });
    await chooser();
    walletButtons()[0]!.click();
    await expect(p).resolves.toBeNull();
    const back = finishRedirectSignIn({ url: "https://x.example/back#accountId=bob.testnet&publicKey=ed25519%3Akk&signature=sig%3D%3D" });
    expect(back).toEqual({ accountId: "bob.testnet", publicKey: "ed25519:kk", signature: "sig==", message: ch.message, nonce: ch.nonce, recipient: "x.example", callbackUrl: "https://x.example/back" });
  });
});

describe("finishRedirectSignIn", () => {
  it("is null without a saved challenge or a signature, and reports wallet errors", () => {
    expect(finishRedirectSignIn({ url: "https://x.example/back#accountId=a&publicKey=b&signature=c" })).toBeNull();
    sessionStorage.setItem("nearkit:wallet-login", JSON.stringify({ message: "m", nonce: "n", recipient: "r", callbackUrl: "c" }));
    expect(finishRedirectSignIn({ url: "https://x.example/back" })).toBeNull();
    expect(finishRedirectSignIn({ url: "https://x.example/back?error=User+rejected" })).toEqual({ error: "User rejected" });
  });
});
