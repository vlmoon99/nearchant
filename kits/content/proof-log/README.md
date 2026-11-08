# Proof log

Prove a post, file or AI output existed unchanged at a time: write its sha256 fingerprint — plus who or what made
it — to an append-only log on NEAR, and check any copy against it later.

## Copy it

1. Copy the folder `kits/content/proof-log/` into your project (the TypeScript client at the root, the contract in `contract/`).
2. Install: `npm i near-api-js@7.4.0`
3. Import:

```ts
import { ProofLog, fingerprint, keySigner } from "./proof-log/src/index.js";
```

Deploy the contract once (below), or use one someone already deployed — entries are signed by their author, so a
shared log is fine.

## Use it

```ts
const log = new ProofLog({
  contractId: "proofs.yourname.testnet", // network: "testnet" by default
  signer: keySigner({ accountId: "you.testnet", secretKey: process.env.NEAR_KEY! }),
});

// An AI-made post: caption + picture + the model that wrote it.
const post = { caption: "Fresh sourdough today!", image: await readFile("post.png") };
const { id } = await log.prove(post, { producer: "model:qwen3 + qwen-image-edit", subject: "post:123", madeAt: new Date() });

// Later, anyone: is this copy the one that was proven, and when?
const entry = await log.check(post, { authorId: "you.testnet" }); // earliest matching entry, or null
// entry.created_at = block time in ns; an edited caption gives null
```

`fingerprint(content, meta)` alone builds the entry without writing it (e.g. to send it from a backend queue, or
from a wallet). Content is a string/Buffer, or named parts (`{ caption, image }`): each part's hash goes into the
metadata, so a single part can be checked later too.

Run `npx tsx example.ts [file]` for a dry run, or set `PROOF_LOG_CONTRACT`, `AUTHOR_ACCOUNT`, `AUTHOR_KEY` to write on testnet.

## Options

`new ProofLog(options)`:

| Option | Default | What |
|---|---|---|
| `contractId` | — (required) | the proof-log contract account |
| `network` | `"testnet"` | `"testnet"` or `"mainnet"` (mainnet is untested) |
| `rpcUrls` | public fastnear + near.org RPCs | your RPC endpoints; several = failover |
| `signer` | none | who writes (the entry's author); `.as(signer)` to switch |
| `view` | JSON-RPC via near-api-js | replace the read function (tests, caching) |
| `timeoutMs` / `txTimeoutMs` | 15 000 / 60 000 | per read / per write |
| `retries` / `retryDelayMs` | 3 / 300 | read retries with exponential backoff + jitter |

`fingerprint(content, meta)` meta: `producer` (≤ 200 chars), `subject` (≤ 128), `passed` (a review result),
`madeAt` (your clock, kept in metadata), `metadata` (any JSON object; the whole metadata must stay ≤ 2048 bytes).

`record(entry, { dedupe = true, depositYocto })`: with `dedupe`, an entry with the same author + hash + subject is
not written twice (that's the idempotency key, so retries are safe). The storage deposit is estimated and the
contract refunds what it doesn't use (typically ~0.005–0.01 NEAR per entry is kept).

Reads: `get(id)`, `listByAuthor(author, { fromIndex, limit })`, `countByAuthor(author)`, `findByHash(hash)`,
`check(content, { authorId })`, `isPassed(id, subject, author)`.

## How it works

```mermaid
sequenceDiagram
  participant App
  participant Log as proof-log contract
  App->>App: fingerprint(content) = sha256 (+ part hashes, producer, subject)
  App->>Log: record(entry) + storage deposit (signed by the author)
  Log-->>App: id (author = signer, created_at = block time; excess deposit refunded)
  Note over Log: entries never change or disappear
  App->>Log: find_by_hash(sha256(copy))
  Log-->>App: earliest entry → it existed, unchanged, at that block time
```

- Only hashes go on chain, never the content. Don't put secrets or personal data in `producer`, `subject` or
  metadata: the log is public forever.
- The author is always the account that signed. Trust an entry only if its author is who you expect.
- The writer pays storage (`record` is payable and refunds the excess), so nobody can drain the contract.
- Events are NEP-297 logs: `EVENT_JSON:{"standard":"proof_log","version":"1.0.0","event":"proof_recorded",…}`.
- `is_passed(proof_id, subject, author_id)` is the hook the `market/escrow` kit uses: with `proof_log_id` set, a
  seller can only mark an order delivered with an entry they wrote about that order (`subject` = order id) that
  didn't fail review.

### Deploy

```sh
cd contract
cargo near build non-reproducible-wasm            # → target/near/proof_log.wasm
near account create-account fund-myself proofs.you.testnet '3 NEAR' autogenerate-new-keypair save-to-keychain \
  sign-as you.testnet network-config testnet sign-with-keychain send
near contract deploy proofs.you.testnet use-file target/near/proof_log.wasm \
  with-init-call new json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

## Tested

- **Contract** (`cd contract && cargo test`, near-workspaces sandbox, 4 tests): record → get, list by author with
  paging, find by hash across authors, `is_passed` (subject, author, failed review, missing entry), refusals (empty or
  long hash, non-JSON metadata, no storage deposit — nothing written), and that the writer pays only the storage used.
- **Client** (`npm test`, no network, 10 tests): sha256 of one value and of named parts, part order, `matches`,
  size limits, prove/get/check/list/count/isPassed against a fake contract, dedupe (and when it doesn't apply),
  recovery after a write timeout, panic messages, read retries/timeout/validation, `rpcView` through near-api-js
  against a fake JSON-RPC `fetch`.
- **Not tested**: a live testnet run of `example.ts`, mainnet, and whether the client's deposit estimate covers the
  largest possible entry on chain (it is about 2× the expected bytes; the contract refunds the excess). Not audited.

## Came from

`contracts/proof-log` in Nearchant, where every published post gets an entry (caption + image hash, the models that
made it, the caption check as review — see `postProofEntry` in `apps/worker/src/content-tasks.ts`), and `orders`
checks a passed entry before delivery. Changes for general use: the entry is `content_hash` + optional `producer`,
`subject`, `passed` and free-form JSON `metadata` (was `task_id`, `order_id`, `brief_hash`, `producer`,
`output_hash`, `attestation_ref` and a required `review`); the writer pays storage; new reads by author and by hash;
`is_passed` takes `subject` (was `order_id`) and counts an unreviewed entry as passed; the event standard is
`proof_log`.
