// A testnet wallet that lives in this browser: an ed25519 key in localStorage and its implicit account (the account id
// is the hex of the public key). No sign-up, no extension — good for demos and testnet checkouts. Never for mainnet
// money: anyone with access to the browser profile has the key.
//
// An implicit account exists on chain only after someone sends it NEAR. `fund` is your hook for that: Nearchant's
// server sends 0.2 NEAR (creates the account, pays gas) and calls `faucet_for(account_id)` on its test token.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { accountExists, rpcUrlOf, sleep, type Network, type RpcOptions } from "./rpc.js";
import type { Payer } from "./pay.js";

export interface KeyStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export interface TestWalletOptions extends RpcOptions {
  network?: Network;
  /** Where the key is kept. Default: localStorage, or memory when storage is blocked (private mode). */
  storage?: KeyStore;
  /** Default `nearkit:<network>:buyer-key`. */
  storageKey?: string;
  /** Called when the account doesn't exist yet: make it exist (send it NEAR) and, ideally, give it test tokens. */
  fund?: (accountId: string, publicKey: string) => Promise<void>;
  /** How long `ready()` waits for the account to appear after `fund`. Default 30 000 ms. */
  waitMs?: number;
}

export interface TestWallet extends Payer {
  publicKey: string;
  /** The account is on chain (it has received NEAR). */
  exists(): Promise<boolean>;
  /** Funds the account if it doesn't exist yet, waits until it does, returns the wallet as a Payer. */
  ready(): Promise<Payer>;
  /** Calls `fund` again (e.g. for more test tokens). */
  fund(): Promise<void>;
  /** Deletes the key from storage. The money on the account is lost unless the key was saved elsewhere. */
  forget(): void;
  /** "ed25519:…" secret key, for a "download my key" button. */
  exportKey(): string;
}

function browserStorage(): KeyStore {
  const mem = new Map<string, string>();
  const ls = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  return {
    getItem: (k) => { try { return ls ? ls.getItem(k) : mem.get(k) ?? null; } catch { return mem.get(k) ?? null; } },
    setItem: (k, v) => { mem.set(k, v); try { ls?.setItem(k, v); } catch { /* memory only */ } },
    removeItem: (k) => { mem.delete(k); try { ls?.removeItem(k); } catch { /* ignore */ } },
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** Implicit account id of an ed25519 key. */
export const implicitAccountId = (key: KeyPair) => hex(key.getPublicKey().data);
const keyName = (o: TestWalletOptions) => o.storageKey ?? `nearkit:${o.network ?? "testnet"}:buyer-key`;

/** The account id of the test wallet already in this browser, or null — never creates one (for a balance pill). */
export function existingTestWallet(o: TestWalletOptions = {}): string | null {
  const s = (o.storage ?? browserStorage()).getItem(keyName(o));
  try { return s ? implicitAccountId(KeyPair.fromString(s as KeyPairString)) : null; } catch { return null; }
}

/** Loads this browser's test wallet, creating the key on first use. */
export function createTestWallet(o: TestWalletOptions = {}): TestWallet {
  if ((o.network ?? "testnet") === "mainnet") throw new Error("createTestWallet is for testnet: on mainnet use a real wallet (fromWalletSelector)");
  const store = o.storage ?? browserStorage(), name = keyName(o);
  let key: KeyPair;
  const saved = store.getItem(name);
  try { key = saved ? KeyPair.fromString(saved as KeyPairString) : KeyPair.fromRandom("ed25519"); } catch { key = KeyPair.fromRandom("ed25519"); }
  if (!saved) store.setItem(name, key.toString());
  const accountId = implicitAccountId(key), publicKey = key.getPublicKey().toString();
  const account = new Account(accountId, new JsonRpcProvider({ url: rpcUrlOf(o) }), new KeyPairSigner(key));
  const wallet: TestWallet = {
    accountId, publicKey,
    call: (c) => account.callFunction({ contractId: c.contractId, methodName: c.methodName, args: c.args, deposit: c.deposit, gas: c.gas }),
    exists: () => accountExists(accountId, o),
    async fund() {
      if (!o.fund) throw new Error("no fund hook: pass createTestWallet({ fund }) or send NEAR to " + accountId);
      await o.fund(accountId, publicKey);
    },
    async ready() {
      if (await wallet.exists()) return wallet;
      await wallet.fund();
      const until = Date.now() + (o.waitMs ?? 30_000);
      while (Date.now() < until) {
        if (await wallet.exists().catch(() => false)) return wallet;
        await sleep(1000);
      }
      throw new Error("The test wallet wasn't funded in time. Try again in a minute.");
    },
    forget: () => store.removeItem(name),
    exportKey: () => key.toString(),
  };
  return wallet;
}
