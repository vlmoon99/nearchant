# Wallet login

Sign in with any NEAR wallet (Meteor, HOT, HERE, Intear, MyNearWallet, Sender…). The wallet signs a one-time NEP-413 message, with no transaction and no fee. Your server checks the signature, then asks NEAR whether that key really is a full-access key of the account.

## Copy it

```sh
cp -r kits/market/wallet-login  your-app/src/wallet-login
cd your-app && npm i @near-wallet-selector/core@10.1.4 @near-wallet-selector/meteor-wallet@10.1.4 \
  @near-wallet-selector/hot-wallet@10.1.4 @near-wallet-selector/here-wallet@10.1.4 @near-wallet-selector/intear-wallet@10.1.4 \
  @near-wallet-selector/my-near-wallet@10.1.4 @near-wallet-selector/sender@10.1.4 @noble/curves@2.2.0 @noble/hashes@2.2.0 @scure/base@2.2.0 buffer@6.0.3
```

```ts
import { createChallenge, verifySignedMessage, statusFor, signIn, finishRedirectSignIn } from "./wallet-login/src/index.js";
```

A server that only verifies needs just `@noble/curves`, `@noble/hashes` and `@scure/base`. The wallet libraries load only when `signIn()` runs.

**Bundling the browser part.** The wallet libraries expect a few Node built-ins. The shims in `shims/` stand in for them. With esbuild:

```sh
esbuild app.ts --bundle --format=esm --platform=browser \
  --alias:util=./wallet-login/shims/util.js --alias:crypto=./wallet-login/shims/crypto.js \
  --alias:http=./wallet-login/shims/empty.js --alias:https=./wallet-login/shims/empty.js \
  --inject:./wallet-login/shims/process.js --define:process.env.NODE_ENV='"production"' --define:global=globalThis
```

Vite and webpack take the same aliases. `example.ts` does all of this through esbuild's API. Include `wallet-login.css` on the page.

## Use it

```ts
// server
const RECIPIENT = "shop.example";                       // your host, from config — never from the request
app.get("/login/challenge", (c) => c.json(createChallenge({ recipient: RECIPIENT })));
app.post("/login/verify", async (c) => {
  const r = await verifySignedMessage(await c.req.json(), { recipient: RECIPIENT, network: "mainnet" });
  if (!r.ok) return c.json(r, statusFor(r));             // 400 bad input, 503 NEAR unreachable, 401 otherwise
  // r.accountId is proven: start your session here.
  return c.json({ accountId: r.accountId });
});

// browser
const signed = await signIn({ network: "mainnet", challenge: () => fetch("/login/challenge").then((r) => r.json()) });
if (signed) await fetch("/login/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });

// on the callbackUrl page (redirect wallets such as MyNearWallet come back here)
const back = finishRedirectSignIn();   // SignedLogin | { error } | null → POST it the same way
```

Run `npx tsx example.ts` to try it, then open <http://localhost:8790>.

## Options

`verifySignedMessage(input, options)`: `input` = `{ accountId, publicKey, signature, message, nonce, callbackUrl? }`, which is what `signIn` returns.

| Option | Default | Meaning |
|---|---|---|
| `recipient` | — | Your host. The wallet signs it, so a signature made for another site fails |
| `network` / `rpcUrl` | testnet, FastNEAR | Where to check the access key |
| `maxAgeMs` | 10 min | Oldest accepted challenge. The issue time comes from the signed nonce |
| `nonces` | in-memory store | Blocks replays. Use a shared `NonceStore` with more than one server. `null` turns it off |
| `requireFullAccess` | true | The key must be a full-access key. See "How it works" for why a function-call key doesn't count |
| `expectedMessage` | — | Require exact message text |
| `timeoutMs`, `retries` | 8 000, 2 | For the RPC call, with backoff |

The result is `{ ok: true, accountId, publicKey, issuedAt }` or `{ ok: false, code, reason }`. `code` is one of:

- `bad_input`
- `bad_signature`
- `expired`
- `nonce_reused`
- `not_full_access`
- `rpc_unavailable`

`createChallenge({ recipient, message?, ttlMs? })` returns `{ message, nonce, recipient, expiresAt }`.

`signIn({ network, challenge, callbackUrl?, modules?, title? })`:

- To use other wallets, pass `modules` (Wallet Selector factories, such as OKX, Bitte or NEAR Mobile).
- Without `modules` you get Meteor, HOT, HERE, Intear, MyNearWallet and Sender.

Lower-level exports:

- `nep413Payload` and `verifyNep413`
- `verifyWalletSignature`, which accepts the signature with or without `callbackUrl`
- `accessKeyPermission(accountId, publicKey)`

## How it works

```
server: createChallenge ─► nonce = 8 bytes issue time ‖ 24 random bytes (stateless; the wallet signs it)
browser: signIn ─► wallet signs sha256(u32 LE 2^31+413 ‖ borsh{message, nonce, recipient, callbackUrl?})
server: verifySignedMessage
  1 shape · 2 age from nonce · 3 ed25519 over the rebuilt bytes with YOUR recipient
  4 claim nonce (before any await on the chain, so two parallel requests can't both pass)
  5 RPC view_access_key(accountId, publicKey) == FullAccess   (timeout, retries, finality optimistic)
```

A valid signature alone only proves someone holds *a* key. Step 5 proves the key belongs to the account and can control it. Function-call keys don't count, because dapps hold those and any site the person connected to could have one.

Some wallets drop `callbackUrl` before signing; Meteor does this through Wallet Selector 10.1.4. Redirect wallets keep it. `callbackUrl` only says where to go next, so either form is accepted.

If the RPC fails after the nonce is claimed, the person has to sign again.

## Tested

There are 25 unit tests, plus 1 live test that is skipped by default. The keys are generated with near-api-js `KeyPair`.

The NEP-413 payload bytes are pinned, along with a fixed signature vector. Both were cross-checked by hand against Nearchant's production verifier: identical bytes, and that verifier accepts the signature.

The tests show these fail:

- A tampered message, nonce, recipient or callbackUrl
- An expired challenge, or one from the future
- A replay
- A key that isn't on the account
- A function-call key
- The right key claimed for another account
- An RPC that is down (503 after retries) or hanging (timeout)

They also cover:

- RPC retry on network errors and 5xx
- Signatures in base64, base64url and base58
- The chooser UI with a fake Wallet Selector: listing, picking, connecting first, wallet errors, close, redirect hand-off
- `finishRedirectSignIn`

`NEARKIT_LIVE=1 npx vitest run test/live.test.ts` checks `view_access_key` on real testnet: a full-access key, an unknown key, and an unknown account.

**Checked by hand:**

- `example.ts` in headless Chrome: the chooser listed all six wallets.

**Not tested:**

- A real signature from a real wallet through the example (it needs a person and a wallet)
- Mainnet

## Came from

Nearchant's "Sign in / link your NEAR wallet" (ADR 0022):

- `apps/gateway/web/wallet.ts` (the chooser)
- `apps/gateway/src/nep413.ts`
- `/api/wallet/verify` in `apps/gateway/src/seller-app.ts`, with `isOwnerKey`
- `walletGo` and `walletConnectPage` in `apps/gateway/web/app.ts`
