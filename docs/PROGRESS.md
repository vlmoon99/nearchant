# Progress

Newest entry last. Each entry: what was done, how it was verified, what is NOT verified, what's next.

## 2026-10-31 (before the hackathon window — docs only)

- Grilled the plan with the owner; decisions recorded in `m0-scope.md` and ADRs 0001–0015.
- `docs/initial_plan.md` → `docs/architecture.md` with a status banner and ADR references; `CLAUDE.md` written.
- Facts checked live: NEAR AI Cloud has FLUX.2-klein-4B, whisper-large-v3, Qwen3 embed/rerank, tool-calling chat
  models and a public attestation endpoint; 1Click and Agent Market x402 are mainnet-only; Shade Agents
  deprecated; `nearchant.testnet` did not exist yet.
- Machines: `gx10-c3c8` (100.64.0.1) is the inference_system database master with no engines running;
  `dgx-spark-2` offline; `gx10-8695` (100.64.0.13) is fresh but user `server` can't use Docker there (not in
  the `docker` group; sudo needs a password). **Owner action:** `sudo usermod -aG docker server` on it.
- `nearchant.testnet` created via the faucet (10 NEAR); full-access key in the macOS Keychain (near-cli-rs).
- `docs/contracts.md`: interface spec for nusd, handles, orders, billing, proof-log, escrow-policy. Design change
  vs the grilling session: `escrow-policy` holds campaign budgets and is the payer, so spend caps stay on chain;
  budget subaccounts remain only for paying real market agents (ADR 0009 amendment). **Owner: please review.**
- Next (from 2026-11-01 00:00 UTC): cargo workspace `contracts/`, nusd + handles first, sandbox tests.
- Toolchain checked in a scratch folder outside the repo (no project code before the window): `cargo near build`
  works; a `near-workspaces` 0.24 sandbox test passes on this Mac (arm64). Gotchas for the real workspace:
  (1) near-sdk 5.30's `unit-testing` feature fails to resolve (`near-vm-runner` is prerelease-only) → no unit-test
  feature, test through the sandbox; (2) sandbox tests live in a separate `contracts/tests` crate that reads the
  built `.wasm`, because building the contract crate for the host is a compile error.
- testnet balance topped up to ~20 NEAR (throwaway faucet accounts deleted into `nearchant.testnet`). Docker
  Desktop started; pgvector:pg16, cloudflared, node:24-slim pulled; pnpm enabled via corepack.

## 2026-10-31 / 11-01 night — contracts done and live on testnet

- **Done:** six contracts in `contracts/` (Rust, near-sdk 5.30, cargo-near 0.22): `nusd`, `handles`, `proof-log`,
  `orders`, `billing`, `escrow-policy`, following `docs/contracts.md`. `make test-contracts` builds all and runs
  the sandbox suite. `deploy/testnet/deploy.sh` creates/upgrades every contract (idempotent, keys from the
  Keychain). Account ids in `config/defaults/accounts.yaml`.
- **Verified:** 25 near-workspaces sandbox tests pass (faucet limits; handle names/reserved/rollback+refund/
  scoped agent keys; proofs bound to author+order; orders happy path, duplicates, unknown seller, revision →
  refund, release timeout, delivery deadline, failed payout reverts; billing caps/idempotent batches/sweep/
  withdraw; escrow auto vs approval, in-flight daily limit, 5% fee to Nearchant payees, close refund, failed
  transfer releases reservation). **Live testnet loop:** `link demo` → faucet → pay 5 nUSD → `order_created`
  → proof → `mark_delivered` → `accept` → `order_released`, orders balance back to 0
  (tx `9hjiTYf3fY8sMYKk8mdyHxH1MEMzzhpqdu1DUTs9w692`).
- **Fixed on the way:** the first deploy left contracts uninitialised (my probe was wrong) — anyone could have
  called `new`. Initialised them within minutes signed by each contract account; every `new` is now
  `#[private]` and the script inits only on "not initialized".
- **Local model:** `gx10-8695` runs `nc-llm` (vLLM, Qwen3.6-35B-A3B NVFP4, 32k ctx) on `100.64.0.13:8010`,
  key in `~/nearchant-node/engine.env` on that machine (not in the repo). Loads in ~3.5 min; reasoning is on by
  default (send `chat_template_kwargs: {enable_thinking: false}` for fast calls).
- **Not verified:** `claim`/`claim_for` on live testnet (only in sandbox); billing and escrow on live testnet;
  reproducible builds (using non-reproducible wasm for now).
- **Next:** monorepo skeleton (pnpm + Turborepo), `spec/schemas` + generated types, router with `nearai`,
  `local` (gx10-8695) and `replay` adapters, then the gateway.

## 2026-11-01 early — monorepo, schemas, router (live)

- **Done:** pnpm + Turborepo workspace (TypeScript 7, Node 24, Vitest 5). `spec/schemas/` (common, result envelope,
  providers config, usage record) → `packages/contracts` generates TS types and validates with Ajv (ADR 0016).
  `packages/providers`: capability router (priority routing, privacy tiers, model choice from the live catalog with
  per-endpoint `model_map`, retry with backoff on 429/5xx only, circuit breaker, NEAR AI attestation pinned before
  private calls, cost from `prices`), OpenAI-compatible adapter (chat, vision, embed, rerank, images, asr), replay
  adapter + recorder. `config/providers.yaml`: `spark-8695` (local) → `nearai` (tee).
- **Verified:** 7 router tests against fake OpenAI servers. Live smoke (`packages/providers/scripts/smoke.mjs`):
  private chat → spark-8695 Qwen3.6-35B in 394 ms; GLM-5.3-flash via nearai with attestation; embeddings via
  nearai (dim 1024). Keys from the Keychain (`NEARAI_API_KEY`, `NC_LOCAL_LLM_KEY`).
- **Not verified:** images, asr, rerank against live NEAR AI; attestation is fetched + hashed, **not**
  cryptographically verified (envelope says `verified: false`). `prices` empty until checked against NEAR AI's
  price list, so `costUsd` is 0 for now.
- **Next:** gateway (Hono): config loading, `/health`, public catalog + order API, handle cache from contract
  events, relayer signing; then the swarm.

## 2026-11-01 ~00:00 UTC — packages/near + gateway skeleton, checkout path live

- **Done:** `packages/near`: failover RPC chain client, relayer-signed calls, `HandleCache` (TTL, negative cache,
  dedupe, serves a recent record when RPC is down, never older than 24 h), `handleFromHost` (one label only),
  `TestnetDirectRail`, `oneClickDryQuote` (needs `refundType: INTENTS` for dry quotes). `apps/gateway` (Hono):
  seller card SSR at `<handle>.<base>` and `/h/<handle>`, 404 card, `/public/catalog`, `POST /public/orders`
  (returns the ft_transfer_call the buyer signs + live any-chain quote), `GET /public/orders/:id` (marks paid
  only when the chain shows the order with the right seller and amount, once), CORS allowlist + PNA preflight,
  CSP `script-src 'self'`. `config/gateway.yaml`, `config/seed.yaml` (demo catalog).
- **Verified:** 4 near tests, 7 gateway tests. Live: gateway on the Mac read handle `demo` from testnet, created
  order `o-mvx0nhx3-c4bfca79`, I paid 5 nUSD on testnet, gateway showed `paid` / chain `Held` and fired `onPaid`
  once. 1Click dry quote live: 5 USDC on NEAR ≈ 5.0567 USDC from Solana, ~20 s.
- **Not verified / not done:** store is in-memory (Postgres next); no buyer wallet yet (sponsored buyer accounts
  + in-browser signing); `onPaid` doesn't start the swarm yet.
- **Next:** Postgres store (Drizzle, pgvector, compose), then the swarm engine and deck producer.

### Owner actions
- ~~`gx10-8695`: add `server` to the docker group~~ — done 2026-10-31; Docker 29.6 + GPU in containers verified.
- Testnet NEAR: root has ~7.9 NEAR after deploying; each sponsored shop costs ~0.2 NEAR. I'll top up from the
  faucet as needed.
- Phala Cloud account with credit, needed by ~8 Nov.
- Cloudflare: a tunnel token for `*.nearchant.com` (or API token so I can create it), needed by ~6 Nov.
