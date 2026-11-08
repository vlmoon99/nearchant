# Checkout

A pay button for NEAR escrow checkouts in the browser. It sends a NEP-141 `ft_transfer_call` from a test wallet or any NEAR wallet, waits until the escrow shows the order as paid, and walks the buyer through each step in a payment sheet.

## Copy it

```sh
cp -r kits/market/checkout  your-app/src/checkout
cd your-app && npm i near-api-js@7.4.0
```

```ts
import { createTestWallet, payWithSheet } from "./checkout/src/index.js";
```

Add `checkout/checkout.css` to your page.

**Bundling:** near-api-js pulls in a dependency that wants Node's `util`, so alias it to the shim that comes with the kit:

- esbuild: `--alias:util=./checkout/shims/util.js`
- Vite: `resolve.alias: { util: "./checkout/shims/util.js" }`
- webpack: `resolve.alias.util`

## Use it

```ts
import { createTestWallet, payWithSheet } from "./checkout/src/index.js";

const wallet = createTestWallet({
  network: "testnet",
  // Runs when the account doesn't exist yet. Your server sends it NEAR, plus test tokens if you have them.
  fund: (accountId, publicKey) => fetch("/api/sponsor", { method: "POST", body: JSON.stringify({ accountId, publicKey }) }).then(() => {}),
});

button.onclick = () => payWithSheet({
  token: "nusd.nearchant.testnet",       // NEP-141 token
  escrow: "orders.nearchant.testnet",    // contract with ft_on_transfer
  amount: "5000000",                     // base units (5 nUSD, 6 decimals)
  orderId: `o-${crypto.randomUUID()}`,   // unique; also the idempotency key
  seller: "alice.testnet",
  payer: () => wallet.ready(),
  paid: (r) => ({ buttons: [{ label: "Open my order", primary: true, href: `/orders/${r.orderId}` }] }),
});
```

If you don't want the sheet, `payWithEscrow(options)` runs the same flow and reports through `onStep(e)` (`e.step`: `wallet | pay | confirm`, `e.state`: `now | done | bad`).

To pay from a real wallet, such as on mainnet, use `payer: fromWalletSelector(wallet, accountId)` with a signed-in NEAR Wallet Selector wallet.

There is a runnable example: run `npm run example`, serve the folder, and open `example.html?token=…&escrow=…&amount=…&seller=…&fund=<your sponsor URL>`.

## Options

`payWithEscrow` / `payWithSheet`

| Option | Default | Meaning |
|---|---|---|
| `token`, `escrow` | — | Token contract and escrow contract |
| `amount` | — | Base units as an integer string (U128) |
| `orderId` | — | Unique per order. Before paying, the kit checks whether this order is already paid |
| `payer` | — | A `Payer` (`{accountId, call}`), or a function that returns one. The function runs in the "Preparing wallet" step |
| `seller` | — | The seller account; added to the default msg |
| `msg` | `{"order_id","seller"}` (the escrow kit) | The `ft_transfer_call` msg, as a string or `(orderId) => string`. Change it to match your escrow |
| `checkPaid` | escrow `get_order` | `(orderId) => "paid" \| "pending" \| "missing"` |
| `confirmTimeoutMs` | 60 000 | After this the result is `status: "pending"` (the transfer went through but the escrow hadn't shown it yet) |
| `missingGraceMs` | 15 000 | If the order is still missing this long after the transfer, the escrow refused it (error `refused`) |
| `pollMs` | 2 000 | How often to check the order |
| `gasTgas` | 100 | Gas for `ft_transfer_call` |
| `registerEscrow` | true | `storage_deposit` for the escrow on the token when it isn't registered |
| `checkBalance` | true | Stop before signing when the token balance is short |
| `network` / `rpcUrl` | testnet, FastNEAR | RPC used for views |
| `timeoutMs`, `retries` | 8 000, 2 | Per RPC request |
| `finality` | `optimistic` | For views |
| `sheet` (sheet only) | — | `{ title, subtitle, labels: {wallet, pay, confirm} }` |
| `paid` (sheet only) | — | `(result) => ({ title, text, buttons })` for the success screen |

`createTestWallet({ network, fund, storage, storageKey, waitMs })` returns `{ accountId, publicKey, ready(), exists(), fund(), forget(), exportKey(), call() }`. `existingTestWallet()` returns the account id without creating a key, which is handy for a balance pill.

Other exports:

- `checkForm(form, rules, { out, wrapper })` with `rules.required / email / phone / oneOf` and `contactRules()`, plus `clearOnInput(form)`
- `tokenBalance({ token, accountId })`, `formatUnits(units, decimals)` and `parseUnits(text, decimals)`
- `PaySheet` (open / step / paid / pending / failed / close)
- `viewCall` and `rpc`

Errors are `PayError` with a `code`:

- `not_enough_balance`
- `rejected`
- `refused` (the escrow returned the money)
- `network`
- `failed`

They also carry `maybeSent`. `payErrorText(e)` turns any error into words a buyer can act on.

## How it works

```
Preparing wallet ── payer() (test wallet: fund hook if the account is new) · already paid? · balance ≥ amount?
Paying ─────────── storage_deposit(escrow) if not registered · ft_transfer_call(escrow, amount, msg), 1 yocto
Confirming ─────── poll checkPaid / get_order: Opening → Held = paid; still missing after the grace period = refused
```

**Test wallet.** It keeps an ed25519 key in `localStorage` (`nearkit:testnet:buyer-key`). The account id is the hex of the public key, which makes it an implicit account. The account appears on chain once it receives NEAR. Here is how Nearchant funds it with its `fund` hook: the browser posts the public key, and the server first checks a rate limit. It then sends 0.2 NEAR from a relayer, which creates the account and covers gas. Finally it calls `faucet_for({account_id})` on its test token `nusd`. That method is relayer-only, mints 100 nUSD once a day, and the token pays the storage. A funded account can also call the token's own `faucet()` itself. The key never leaves the browser.

**Idempotency.** The order id is the key. The kit asks the escrow about the order before sending anything. Nearchant's escrow also returns the full amount for an order id it has already seen. So "Try again" after a timeout can't charge twice. The transaction itself is never retried automatically.

**Finality.** Views use `optimistic`. With `final`, a balance read right after a faucet transfer still showed 0.

## Tested

There are 38 unit tests, plus 1 live test that is skipped by default. The unit tests run against a fake RPC as a fetch function. In happy-dom they cover:

- The full pay flow and its step events
- Escrow registration
- Already paid, which sends nothing
- Short balance
- Custom msg
- Refusal, both from the `"0"` result and from a missing order
- Pending on timeout
- Network errors while paying (`maybeSent`)
- Wallet rejection
- An order id that holds a different payment
- RPC hiccups while confirming
- RPC retry on 503, timeout, and no retry on contract errors
- `optimistic` finality
- Unit formatting
- The test wallet's key storage, fund hook and mainnet refusal
- The sheet's states, escaping, Try again and close
- Form rules and marks

`NEARKIT_LIVE=1 npx vitest run test/live.test.ts` reads Nearchant's escrow and token on real testnet. It needs no keys.

**Not tested:**

- A live testnet payment (signing and sending `ft_transfer_call`)
- `fromWalletSelector` against real wallets
- Mainnet
- The CSS, beyond class names

## Came from

Nearchant's store checkout: `apps/gateway/web/checkout.ts` (`payItem`, `checkForm`, `payError`), `apps/gateway/web/ui-bits.ts` (`sheet`, `tokenBalance`), the sheet and steps styles in `apps/gateway/web/ui.css`, buyer sponsoring in `apps/gateway/src/buyers.ts`, and the escrow's `ft_on_transfer` in `contracts/orders/src/lib.rs`.
