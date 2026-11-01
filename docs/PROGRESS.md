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

## 2026-11-01 00:00–01:00 UTC — swarm live, delivery path, billing, compose; repo public

- **Done:**
  - `packages/db` (Postgres/Drizzle: store, artifacts, envelopes, outbox, sealed secrets), `packages/swarm`
    (agent env loader, role asker with JSON repair + seat fallback, 8-step deck pipeline, deterministic deck
    checks), `packages/billing` (usage records with integer math, Merkle batches + proofs).
  - `envs/deck-seller`: roles + prompts as data. Second seat `z-ai/glm-5.3-flash` (ADR 0017).
  - `apps/worker`: graphile-worker `deck_step` per step, `outbox_drain` (deliver = `proofs.record` +
    `orders.mark_delivered` signed by the seller's sealed agent keys; `billing.settle`), `billing_settle` cron.
    CLI for live runs and recordings; SearXNG search (recorded for replays); Marp server rendering.
  - `apps/gateway`: Postgres store, swarm job on paid, sponsored buyer wallets (implicit accounts, rate-limited),
    browser checkout bundle (buyer signs payment / accept / revision), order page with live progress + preview +
    downloads, `/media`, A2A agent card.
  - Testnet: **`alice.nearchant.testnet`** created via `claim_for` (owner key in Keychain `NC_SELLER_alice_OWNER`,
    3 function-call agent keys sealed in Postgres), 100 nUSD, billing balance 20 nUSD.
  - Router: live prices from the NEAR AI catalog; per-model attestation cache that no longer trips the endpoint
    breaker.
  - `deploy/Dockerfile`, `deploy/local/compose.yaml` (db, gateway, worker, renderer, optional tunnel, demo
    profile), `Makefile` (`demo`, `up`, `test`, `test-contracts`, `doctor`). README draft.
  - Repo made **public** after a full-history secret scan (no key values found).
- **Verified:** tests — contracts 25, providers 9, near 4, db 6, swarm 9, billing 2, gateway 8. Live runs on real
  models: full pipeline brief → research (live web) → council → write → FLUX cover → review in 2–9 minutes;
  FLUX cover checked by eye. Found + fixed live: GLM token budget on long prompts; DeepSeek/Kimi have no NEAR AI
  attestation (router correctly refused private data; ADR 0017); reviewer too strict on derived arithmetic.
- **Not verified yet:** a deck passing review end to end + render + on-chain delivery through gateway + worker;
  the browser checkout in a real browser; billing settlement on testnet; `make demo` from recordings; the Docker
  stack running (image builds).
- **Next:** finish the recorded demo run → `make demo`; full E2E (gateway + worker + browser) on alice; settle a
  billing batch on testnet; then Telegram bots, market listing, flow 3, Phala.

## 2026-11-01 ~00:40 UTC — first full order end to end in a real browser (flows 1 + 2 on testnet)

- **Verified live** (gateway + worker on the Mac, Postgres in Docker, models on gx10-8695 + NEAR AI, testnet):
  `apps/gateway/e2e/buy-deck.mjs` drove installed Chrome: card `alice.localhost` → brief → sponsored buyer wallet
  (implicit account, 0.2 NEAR + 100 nUSD) → paid 5 nUSD (`order_created`, Held) → gateway confirmed on chain →
  swarm job → 7.5 min of agents (brief, research with live web, council Qwen+GLM, write, FLUX cover, review gate,
  Marp render) → outbox: `proofs.record` (proof 2, author alice, TEE attestation ref) + `orders.mark_delivered`
  signed by alice's sealed agent keys → order page showed preview + PDF/PPTX → browser clicked Accept →
  `Released`; alice 85 nUSD (= 100 − 20 billing top-up + 5). Order `o-mvx37ptd-811fb680`.
  Billing: batch `b-6-14` settled on chain, alice charged 17,738 units (0.0177 nUSD = TEE calls + 10%; Spark free),
  statement with Merkle root + signed records in `.media/batches/`.
- **Fixed on the way:** CSP blocked the browser's RPC calls (connect-src); buyers underfunded for prepaid gas;
  review gate redesigned (blocking vs suggestions) after GLM kept finding new style issues; open questions may only
  appear as "Open question/Assumption"; rework keeps exactly one cover.
- **Not verified:** `make demo` from recordings (recording in progress); Docker stack running end to end; refund /
  revision paths in the browser (covered by contract tests only).
- **Next:** `make demo`, then flow 3 (escrow hire over A2A/x402 to a second Nearchant agent), Telegram bots,
  Agent Market listing, tunnel for `*.nearchant.com`, Phala.

## 2026-11-01 ~01:10 UTC — flow 3 live: agent hires agent over A2A, paid through escrow

- **Done:** `envs/fact-checker`; `packages/swarm/src/hire.ts` (A2A SendMessage → 402 x402-style terms →
  `escrow.pay` → retry with `X-PAYMENT`); new pipeline step `factcheck` between council and write (failure =
  skipped, never blocks); gateway `POST /a2a/v1` per seller (402 terms; verifies the escrow payment on chain: Paid,
  to this seller, ≥ price, memo = task id; each payment redeemed once via `a2a_payments`; runs the service's agent
  env; meters to the seller); migration 0001 (`services.agent_env`, `a2a_payments`); `admin-cli add-service`,
  `--no-deck`; `config/gateway.yaml` `hiring.factcheck`.
- **Testnet:** `verity.nearchant.testnet` (fact-check, 0.5 nUSD, owner key Keychain `NC_SELLER_verity_OWNER`);
  alice campaign `alice-main` funded 10 nUSD, policy auto ≤ 2 nUSD, daily ≤ 20, allowlist [verity].
- **Verified live:** direct hire in 8.2 s — escrow payment 1 auto-approved, verity answered verdicts, verity
  +0.475 nUSD (5% fee to treasury), campaign spent 0.5. Tests: swarm 10, gateway 9 (402, replay refused,
  unsettled / wrong payee / wrong task refused).
- **Not verified:** the `factcheck` step inside a full browser order (next E2E run); approval path for payments
  above the auto limit (contract-tested only).

## 2026-11-01 ~01:30 UTC — create-your-shop, Telegram bots, sturdier agents

- **Done:** `/new` "Create your shop in 60 s" (browser-made owner key, sponsored `claim_for` + agent keys + deck
  service, billing top-up signed in the browser, key download). Telegram (ADR 0011): `/h/<handle>/manage` connects
  a seller's own BotFather token, authorised by a signature from the shop's full-access key (checked on chain);
  token + webhook secret sealed; webhook when `public_url` is https, long polling otherwise; `/start` shows the
  catalog with order buttons, other messages go to a new `buyer-chat` role (catalog prices only), metered to the
  seller. Asker: length retry no longer burns a parse attempt; repeated bad JSON from the second seat falls back
  to the main seat.
- **Verified:** browser e2e created `e2emvx3qrtr.nearchant.testnet` (1 full key + 3 function-call keys, billing 10
  nUSD, card renders). Tests: gateway 13 (bot /start, chat, safe failure, signature by key/action/handle/time,
  webhook secret), swarm 11. Webhook without secret → 401.
- **Not verified:** a real Telegram bot (needs a BotFather token — owner action); `make demo` (recording again
  after a reviewer JSON failure crashed the previous one).

## 2026-11-01 ~02:00 UTC — make demo green, market integration, redaction

- **Done:** deterministic redaction after the last review round (reviewer quotes offending text; those lines are
  removed; ship only if hard checks pass). NEAR AI Agent Market integration (signed `hire.created` webhook →
  same swarm; deliver = proof on NEAR + `submit` to the market). Curated recording `fixtures/replay/deck` and
  `make demo`.
- **Verified:** live recording run passed review 6 → 8 in 256 s (16 calls). `make demo` (Docker, no keys) replayed
  all 16 calls in 3 s and produced the **identical** deck (output hash `13ee9e3e…`), PDF/PPTX/HTML. Tests: gateway 15,
  swarm 13.
- **Next:** run the stack on gx10-8695 in Docker (ADR 0007 primary), tunnel `*.nearchant.com` (needs Cloudflare
  token), Phala standby (needs account), README polish + video script.

## 2026-11-01 ~02:30 UTC — stack runs on the Spark; all three flows in one browser order

- **Done:** the whole stack (Postgres, gateway, worker, renderer) runs in Docker on **gx10-8695** from a clone of the
  public repo (`~/nearchant`), secrets in `deploy/local/.env` there (mode 600, git-ignored, written from the Mac
  Keychain over SSH). Database + media migrated from the Mac. Gateway listens on the tailnet (`100.64.0.13:8787`).
  The Mac now only develops. Quiet `accountExists` (no error logs for new wallets).
- **Verified live:** `buy-deck.mjs` against `http://100.64.0.13:8787/h/alice/`: paid → brief → research → council →
  **factcheck hired verity via escrow payment 2** → write → design → review → render → proof + `mark_delivered` →
  accept → `Released`, 577 s. Order `o-mvx4o3mw-25ffd720`.
- **Redeploy on the Spark:** `ssh server@100.64.0.13 'cd ~/nearchant && git pull && docker compose -f
  deploy/local/compose.yaml up -d --build gateway worker'`.
- **Next:** Cloudflare tunnel for `*.nearchant.com` (needs token), Phala standby, polish (dashboard balance/top-up,
  README video script).

## 2026-11-01 ~02:45 UTC — CI green; dashboard; Phala groundwork

- **Done:** GitHub Actions CI (`.github/workflows/ci.yml`): contracts (prebuilt cargo-near + sandbox tests),
  TypeScript (all packages, Postgres service), `make demo`. Seller dashboard on `/h/<handle>/manage` (wallet,
  inference balance + spend, hiring budget + policy, recent orders). `config/providers.cloud.yaml` +
  `PROVIDERS_FILE`; `deploy/phala/compose.yaml` + `docs/deploy-phala.md`. `docs/demo-script.md` (90 s video).
- **Fixed:** Marp server mode exits on an empty folder → renderer seeds a placeholder (also a production bug on
  fresh volumes); demo container runs as the host user (Linux bind mounts).
- **Verified:** CI run `c2f2925`: contracts, typescript, demo all success. `make demo` on the Linux Spark from an
  empty `.media`. Dashboard numbers reconcile with chain (alice 80 nUSD, 19.956 billing, 9 nUSD hiring left).

## 2026-11-01 ~03:30 UTC — security review fixed; reliability fixes; regression green

- **Security review** (independent agent, 14 findings): all high + medium fixed in contracts (upgraded on testnet,
  30 sandbox tests) and services; known low-severity limitations listed in `docs/security.md`.
- **Reliability found by regression runs on the Spark:** relayer nonce clashes between gateway and worker (retry with
  a fresh nonce); GLM timeouts on long review prompts (timeouts fail fast, 150 s per second-seat call, sticky fallback
  to the main seat within a step); last-resort redaction now matches paraphrased quotes, removes lines citing
  unknown findings, ignores untraced claims that match nothing; full diagnostics stored when a job stops.
- **Verified:** browser purchase on the Spark after all fixes — paid → hire verity (escrow payment 4, memo bound to
  the task text) → review (1 line redacted) → delivered on chain → accepted → `Released`, 814 s
  (`o-17461606-…`). CI green. Escrow timers + revision redelivery deployed (revision path not exercised live yet).
- **Known:** an order interrupted by a worker restart mid-step (`o-43187251-…`) stays locked until graphile releases
  it (4 h); if not delivered, the escrow timer refunds the buyer after the 7-day deadline.

## 2026-11-01 ~04:10 UTC — revision path verified live

- `buy-deck.mjs --revise` on the Spark: delivered (538 s) → buyer `request_revision` → escrow timer picked it up →
  write/design/review/render again → redelivered on chain with a **new proof** → accepted → `Released` (1130 s
  total). Order `o-320cfe3f-…`. The order page now shows "revision requested — reworking" and keeps refreshing.
- Observation: the rewrite needed 6 lines redacted (the second pass had no buyer note to work from). Next
  improvement: let the buyer type what to change, and feed it to the copywriter.

## 2026-11-01 ~04:40 UTC — revision with a buyer note, verified live

- Order page: a "what should change?" note is saved with the revision request and passed to the copywriter.
- Verified on the Spark (`buy-deck.mjs --revise`, order `o-61aa40b5-…`): delivered 467 s → revision with note
  ("add a retention plan slide, make the ask more concrete") → redelivered 1171 s → accepted → `Released`. The rewrite
  addressed retention only as an "Assumption:" line (no retention data exists — honest), kept "The Ask".

## 2026-11-01 ~04:50 UTC — both Sparks offline; search bundled with the stack

- Heartbeat: `gx10-8695` (100.64.0.13) and `gx10-c3c8` (100.64.0.1) both dropped off the tailnet at the same time
  (`tailscale status`: offline, rx 0; ping and SSH time out). Most likely a power or network outage at the site. The
  live gateway (`http://100.64.0.13:8787`) is down with them. Testnet contracts are unaffected; CI is green.
- Lesson for the judged deployment: the public URL must not depend on the Sparks. That is already the plan (Phala +
  NEAR AI Cloud, `config/providers.cloud.yaml`); running a cloud-only pipeline from the Mac now to check that path.
- Gap found: the Phala compose had no web search (scouts would fall back to model knowledge). Added a `search`
  service (SearXNG pinned by digest, settings written at start so no mounted files are needed — works in a CVM) to
  both compose files; `SEARXNG_URL` defaults to it. Verified: the compose service returns 20 JSON results.

## 2026-11-01 ~05:40 UTC — the Phala configuration works end to end (cloud models only)

- Ran the full deck pipeline from the Mac with `PROVIDERS_FILE=providers.cloud.yaml` (every call on NEAR AI TEE
  models) and the bundled SearXNG: **delivered in 973 s, 32 model calls**, 12 slides + cover, 7 of 18 findings
  with live web sources, review 4 → 7 → 8 (one GLM reviewer timeout fell back to Qwen as designed). Order
  `cloud-check` (CLI, no chain).
- Two bugs that only show up on cloud Qwen (the Spark's Qwen never hit them), both fixed with tests:
  - The judge spent its whole budget in `reasoning_content` and returned `content: null` with no `finish_reason`,
    so the "more room" retry never fired → an empty answer next to reasoning now counts as out of room; up to two
    doublings. JSON failures now report finish reason + the start of the last answer.
  - The image designer (400 tokens) never got past thinking → new `reasoning: false` role setting (request hint,
    mapped by the OpenAI-compatible adapter to `chat_template_kwargs.enable_thinking=false`; verified on NEAR AI:
    47 tokens, clean JSON). Kept out of the replay key: `make demo` deck hash unchanged.
- Verified: all package tests (providers 10, swarm 19, gateway 16, …), `make demo` same hash, CI green on `fd13885`.
- Not verified: the Phala CVM itself (needs the account); a paid order through the gateway on cloud-only config.
- Next: when the Sparks are back, redeploy there (`git pull` + rebuild) and run `buy-deck.mjs`; point the Spark's
  `SEARXNG_URL` at the bundled service so it no longer depends on `gx10-c3c8`.

## 2026-11-01 ~06:45 UTC — paid browser order on the cloud-only (Phala) configuration

- A separate stack on the Mac (`docker compose -p ncphala`, fresh database, `PROVIDERS_FILE=providers.cloud.yaml`,
  bundled search): `create-shop.mjs` made `cloud15151.nearchant.testnet`, then `buy-deck.mjs` bought from it in
  Chrome: paid (10 s) → agents on NEAR AI TEE models only → delivered on chain (1078 s) → accepted → `Released`.
  Order `o-48f5d7dc-…`. Billing: 4 batches settled on chain (outbox `billing.settle` done ×4).
- The fact-check hire returned 404 (the fresh database has no verity shop) and the job continued without it, as
  designed. Flow 3 stays verified on the Spark (escrow payments 1–4).
- Stack stopped afterwards (volume kept); it does not share data with the Spark.
- Not verified: the Phala CVM itself (needs the account); hiring on a cloud-only deployment (needs verity
  migrated, which the runbook's pg_dump step does).

### Owner actions
- Agent Market: listing alice on market.near.ai is a public listing paid in real USD — your call. If yes: create the
  agent (self-hosted, http) on market.near.ai, paste its `aat_` token at `/h/alice/manage`, set the webhook URL +
  secret it shows (needs the public tunnel URL first).
- Telegram: create a bot with @BotFather and paste the token at `/h/alice/manage` (owner key is in the Keychain
  as `NC_SELLER_alice_OWNER`), or send it to me and I'll connect it.
- ~~`gx10-8695`: add `server` to the docker group~~ — done 2026-10-31; Docker 29.6 + GPU in containers verified.
- Testnet NEAR: root has ~7.9 NEAR after deploying; each sponsored shop costs ~0.2 NEAR. I'll top up from the
  faucet as needed.
- **Sparks offline since ~04:45 UTC 1 Nov**: check power and network on both; when `gx10-8695` is back, the compose
  stack restarts by itself (`restart: unless-stopped`) — I'll verify.
- Phala Cloud account with credit, needed by ~8 Nov.
- Cloudflare: a tunnel token for `*.nearchant.com` (or API token so I can create it), needed by ~6 Nov.
- `gx10-c3c8` / inference_system: its own engines are off; its config still lists the reinstalled `dgx-spark-2`
  (now `gx10-8695`) as node1. Nearchant doesn't depend on it; fix in that repo when convenient.
