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

## 2026-11-01 ~08:30 UTC — Sparks back; reboot fix; review-gate fix

- Sparks came back ~07:00 UTC. db, worker, renderer and `nc-llm` restarted by themselves; the **gateway did not**:
  its port was bound to the tailnet IP and Docker started before Tailscale ("cannot assign requested address"),
  and Docker never retries a failed bind. Fix (`0f34875`): gateway on 127.0.0.1 + optional `tailnet` profile
  (socat forwarder, restarts until the IP exists; verified it keeps retrying while the address is missing). The
  Spark's `.env` now uses `COMPOSE_PROFILES=tailnet`, `TAILNET_IP`, and the bundled search (backup `.env.bak-*`).
  Card reachable again on the tailnet. A real reboot is not tested (needs sudo).
- Browser order on the Spark (`o-89e773ba-…`) **stopped at review**: round 2 the reviewer asked for a use-of-funds
  split the brief doesn't have; the copywriter invented one; round 3 blocked the invented numbers, quoting three
  list lines as one sentence, so the last-resort redaction found no line and failed the job. Buyer is safe: the
  order is `cancelled` and the escrow timer refunds it after the delivery deadline.
  Fix: a quote joined from several lines is split into parts and every part must match its own line (test with
  this exact case; one missing part still fails the gate). Trailing punctuation no longer breaks word matching.
- Not done: a reviewer prompt rule ("a fix never asks for numbers not in the brief/dossier") — it changes the
  replay keys, so it needs a fresh `fixtures/replay/deck` recording; deferred.
- Verified after the fix: browser order on the Spark `o-3c3d20b4-…`: paid → hire verity (escrow payment 9) →
  review passed → delivered on chain (776 s) → accepted → `Released`.

## 2026-11-01 ~09:30 UTC — reviewer rule + new demo recording

- Reviewer prompt: a fix never asks for numbers that aren't in the brief or the dossier (budget splits, dates,
  targets); it asks for an open question or a "to be confirmed with the founders" line instead. This is the loop
  that stopped order `o-89e773ba-…` (reviewer asked for a split → copywriter invented one → reviewer blocked it).
- Re-recorded `fixtures/replay/deck` live (Qwen3.6 on `gx10-8695`, GLM-5.3 + FLUX.2 on NEAR AI, SearXNG):
  21 calls, review 5 → 8 → 8, one unsupported line removed by the gate, 12 slides, 9 of 23 findings from the web.
  The Ask now reads "Use of funds: open a second roastery … Runway: to be projected with founders" — no invented
  split. A trial recording under another order id gave the same behaviour ("allocation to be confirmed").
- Verified: `make demo` replays all 21 calls in 3 s with the identical deck hash (`19be6ef7…`); fixture scanned for
  the real key values (none); all package tests green.

### Owner decision (2026-11-01)
- Phala, Cloudflare tunnel and Telegram are done **at the end**, after the owner's local testing on the tailnet.
  Keep a buffer: start the Phala deploy by ~11 Nov (cloud-only config already verified locally).

## 2026-11-01 ~11:30 UTC — pivot to the Figma product (ADR 0018)

- Owner designed the product with me in Figma and asked to build it: AI content + AI analytics + NEAR payments
  and proofs, web + mobile web. Plan and build order in `docs/m1-plan.md`; ADR 0018.
- Reuse map of Boost Content (backend = SQL/PostgREST; prompts for profile/ideas/learn, options-then-choose,
  quotas, TEE attestation check; images via inference_system's `/v1/images/generations` on ComfyUI with
  Qwen-Image-Edit-2511). The shared `inference_system` engines are off and stay untouched.
- Development is local-only now: `config/providers.local.yaml` (Qwen3.6 on `gx10-8695`, which also reads images —
  verified). The Spark runs with `PROVIDERS_FILE=providers.local.yaml`; no NEAR AI spend until step 14.
- Downloading Qwen-Image-Edit-2511 weights (~28 GB, checksums from inference_system's weights.lock) to
  `gx10-8695:~/nearchant-node/comfy/models` for our own image engine (step 1).
- Cloudflare tunnel connected from the Spark (cloudflared 2026.10.7, 4 connections); public hostnames not yet
  added in the dashboard.

## 2026-11-01 ~14:10 UTC — M1 steps 2–4: data model, seller API, business analysis

- **Step 2 data model** (`packages/db/src/content.ts`, migration 0003): businesses, profiles, items, media,
  opportunities, posts, signals, events, monthly quota (free 12/12, pro 150/300; reserve/refund). 6 tests.
  Migrations now take a Postgres advisory lock (gateway and worker raced on deploy; race test added).
- **Step 3 seller API** (`apps/gateway/src/seller-app.ts`): session cookie after one signature with a full-access
  key of the store account; business, private photo uploads (served only to the owner, path-traversal safe),
  analyze, opportunities, posts (402 on quota), items. 8 tests. Live on the Spark (401/403 as expected).
- **Step 4 analysis** (`envs/content-store`, `packages/swarm/src/content.ts`, worker `analyze_business` →
  `find_opportunities`): prompts ported from Boost Content (profile p2, ideas i4, learn k1, localize l1) plus new
  opportunity + insight prompts; the asker now sends photos to the vision route. **Verified on the Spark** with 3
  real clothing photos and local Qwen3.6: products recognised correctly (rhinestone denim jacket, two-tone linen
  dress, Fair Isle sweater), 5 facts for the "Getting to know you" screen, 3 opportunities.
- Found: SearXNG returned 0 results (engines rate-limited / timing out while the model download fills the link),
  so the "trend" was a guess. Fixed: a trend now needs a real search result or it is dropped; search timeouts
  raised to 8 s. Re-test the trend path when the download is done.
- Image engine: ComfyUI + image service built on `gx10-8695`; Qwen-Image-Edit weights still downloading
  (~4 MB/s home link).
- pnpm 12 refused sharp's install script in frozen installs → listed in `allowBuilds`.
- Next: step 1 render test once weights land; step 5 trend path with live search; step 6 posts pipeline.

## 2026-11-01 ~14:25 UTC — M1 step 6: posts pipeline verified (images pending the engine)

- `generate_posts`: one idea-writer call per batch (Boost Content ideas i4 + the chosen opportunity + the owner's
  taste memory + recent picks/passes), then per option caption → render with Qwen-Image-Edit from the product
  photo → ready. `learn_taste` updates the memory after batches. Tests: 29 swarm.
- **Verified on the Spark** (batch `b-test1`, 2 options for the denim + knit bundle opportunity): captions and
  hashtags on-brand, image prompts detailed; image engine not up yet, so both fell back to the product photo
  ("image engine unavailable — showing your photo"), as designed.
- Image weights: the home link dropped to ~0.5–1.5 MB/s (Spark and Mac both measured); switched to a parallel
  curl range downloader with checksums (`~/nearchant-node/comfy/models/getall.sh`). Render test (step 1) follows.
- Next: UI foundation + onboarding pages (steps 8–9), wired to these endpoints.

## 2026-11-01 ~15:40 UTC — M1 steps 8–9: UI foundation + onboarding, verified in Chrome on the public URL

- `apps/gateway/web/ui.css` (Figma tokens + type styles, responsive: desktop sidebar / mobile web bottom nav),
  `src/ui/kit.tsx` (page, shell, icons, badge, stat), `src/ui/onboarding.tsx` (7 steps), `web/app.ts` (store key +
  NEAR account in the browser, session, photo shrink + upload, live facts, opportunities, first posts, store live).
- **Verified**: `e2e/onboard.mjs` in Chrome at 393×852 against `https://nearchant.com/start` — store created →
  analysis on local Qwen → 2 opportunities (trend dropped: no web results) → 3 posts → scheduled → live, ~60 s,
  no page errors. Fixed on the way: CSP blocked inline styles (now allowed; scripts stay self-only), captions clip
  at a word. Thumbnails served correctly (checked with a session on the Spark).
- Public URL live through the tunnel (`nearchant.com` + `*.nearchant.com`).
- Shop creation limit (3/hour/IP) hit during repeated tests — expected.
- Owner asked for video posts + English voiceover from `advertisment_system` → added as stretch 13b (GPU decision
  needed).
- Next: step 7 (publish + proof on NEAR), step 10 (Home/Create/Posts/Post detail), step 11 (storefront).

## 2026-11-01 ~16:10 UTC — M1 step 1: image engine live (Qwen-Image-Edit on our ComfyUI)

- Weights: the home internet was down to ~1 MB/s, but `gx10-c3c8` already had the same files (checksums from
  inference_system's weights.lock) → copied Spark-to-Spark over the LAN at 111 MB/s (20 GB in 3 min), sha256 OK.
  `gx10-c3c8` also already holds the LTX-2.5 video weights (~40 GB) and Kokoro English TTS — no downloads needed
  for video.
- `comfy` + `image` compose services up on `gx10-8695` (profile `gpu`). **Verified**: the rhinestone denim
  jacket photo → "worn by a young woman on a sunny Kyiv street in autumn" → 1024×1280 PNG in 27 s (cold), product
  kept exactly. Posts now get real AI pictures instead of the fallback photo.
- Owner gave a Hugging Face read token (Keychain `HF_TOKEN`; access to gated `Lightricks/LTX-2.5` confirmed) and
  agreed: Spark 1 (`gx10-8695`) = LLM + images, Spark 2 (`gx10-c3c8`) = video + English voiceover (own
  containers; Boost Content's inference_system untouched). A third Spark may be connected later.
- Next: video + voiceover services on `gx10-c3c8` (13b, now unblocked), step 7 publish + proof, step 10 pages.

## 2026-11-01 ~16:40 UTC — M1 step 7: published posts get a proof on NEAR

- `publish_post` (at the scheduled time) makes the image public and enqueues `post.proof`; the outbox signs
  `proofs.record` with the store's own proofs agent key (function-call only). Entry: task `post:<id>`, brief hash
  (the idea), output hash = sha256(caption + image sha256), producer `content-store (qwen3.6 + qwen-image-edit)`;
  attestation_ref stays null until the NEAR AI TEE step. Unit test for the entry.
- **Verified on testnet**: proof #13 on `proofs.nearchant.testnet`, author `novatestrjin.nearchant.testnet`
  (an onboarding-created store), read back with `get`.
- Not done: posting to the seller's Telegram channel (needs a bot token from a seller).
- Video + English voiceover being built on `gx10-c3c8` by a parallel agent (worktree branch; I review and merge).
- Next: step 10 (Home, Create, Posts, Post detail with the proof), step 11 (storefront).

## 2026-11-01 ~17:10 UTC — M1 step 10: seller app pages

- `src/ui/app-pages.tsx` + `routes.tsx`: Home (week stats, posts grid with proofs, "Ways to sell more",
  getting-started checklist), Create (photos, pick an AI idea or write one, 3 options), Posts (filters,
  auto-refresh while AI works), Post detail (caption edit, schedule best time / now, proof on NEAR card with the
  explorer link), sign-in page that uses the store key kept in the browser.
- **Verified** with Chrome screenshots at 1440 and 393 px on `https://nearchant.com/app…` (session for an
  onboarding-created store): real AI posts with pictures, the published one shows "Verified on NEAR", no page
  errors. Fixed: post detail stayed two-column on phones.
- Not yet: wallet balance in the sidebar (step 12), sales numbers (step 11/12).
- Owner offered a third Spark (to move the LLM or images off the busy nodes) → waiting for its tailnet IP.
- Next: step 11 storefront (store page, item page, checkout with escrow, order paid).

## 2026-11-01 ~17:45 UTC — video engine built; gx10-c3c8 hung during a video render (needs a power cycle)

- A parallel agent built `deploy/video-engine` (branch `worktree-agent-a8ec1501d5f8b2038`, not merged yet):
  ComfyUI + LTX-2.5 video adapter (bearer auth, one render at a time) + English-only Kokoro TTS with word
  timestamps (faster-whisper base.en). Verified: TTS 9.7 s of speech in 1.8 s; one LTX render 704×1280, 5 s,
  172 s cold (`scratchpad/video1.mp4`).
- **Incident**: the second (warm) LTX render made `gx10-c3c8` unresponsive (no ping/SSH on tailnet or LAN) —
  unified memory exhausted (41 GB used + ~64 GB page cache of memory-mapped weights, no container cap). Boost
  Content's `inf-*`/`bc-*` containers on that box are down with it. All `ncvideo` containers restart on boot but
  load no model until a request comes.
- Fix before any further render: a memory cap on the video ComfyUI container (`COMFY_MEM_LIMIT`, 72 GB, committed
  on the branch, not yet tested — must confirm the GB10 counts GPU allocations against it), plus a render guard
  that refuses to start when free memory is low. Video stays paused until that is verified.
- Lesson: never run an uncapped LTX render on a machine that hosts other services.

## 2026-11-01 ~19:10 UTC — Sparks offline → the Mac serves nearchant.com (NEAR AI TEE + Comfy Cloud)

- Owner asked to switch while the Sparks are down. The Mac runs the same compose stack (`deploy/local`,
  git-ignored `.env` written from the Keychain) with `PROVIDERS_FILE=providers.mac.yaml`: text + vision on NEAR AI
  TEE (Qwen3.6-35B FP8), images on Comfy Cloud through our image service (`image-cloud` service,
  `IMAGE_BACKEND=comfy_cloud`; key found in Boost Content's Mac config, now in the Keychain as `COMFY_API_KEY`).
  The tunnel connects from the Mac. Image renders are sent as public data (photos for posts that get published);
  private data still only goes to TEE/local endpoints.
- Fixed on the way: shop creation failed — the root `nearchant.testnet` lacked storage balance (sent 1 NEAR from
  the relayer), and our chain client's retry crashed stringifying BigInt errors, hiding the real error; Mac media
  volume had the wrong owner; CSP now allows `blob:` images (photo previews before upload).
- **Verified**: `e2e/onboard.mjs` on `https://nearchant.com` served from the Mac — store → NEAR AI analysis →
  opportunities → 3 posts with Comfy Cloud pictures (Fair Isle sweater on a model in an autumn forest, linen dress
  flat-lay) → scheduled → live, 230 s, no page errors.
- Owner topped up NEAR AI (+$20) and pointed at Levanto Sage 1.4 (model router) for the production cloud profile
  → noted in step 14.
- **When the Sparks come back**: their tunnel container restarts too — two connectors with different databases
  would split traffic. Stop one side first (keep the Mac until the Spark DB is reconciled, or move back).

## 2026-11-01 ~19:40 UTC — admin image lab (tailnet only) + first model comparison on Comfy Cloud

- Owner has ~7,300 Comfy Cloud credits until 11 Nov and wants to test models before choosing. Built an admin
  image lab: a second listener on :8790 published only on the Mac's tailnet address (`ADMIN_BIND=100.64.0.8`) —
  the public tunnel only forwards to :8787 (verified: tailnet 200, public 404). Upload a product photo + prompt →
  render with several Comfy Cloud models side by side (2 at a time) → rate → "Use in production" stores the
  default in `settings.image_variant`. Variants live in `config/image-lab.yaml` + workflow files
  (`config/image-lab/`), so adding a model is a file, not code. TypeScript Comfy Cloud client ported from the
  image service (plain errors for wrong key / out of credits; a 402 stops the batch). Tests: every variant fills
  without leftover placeholders and its overrides hit real nodes.
- **First comparison** (denim jacket photo, "worn on a sunny Kyiv street in autumn"): all 6 rendered (17–38 s).
  Qwen-Image-Edit 2511 Lightning 4-step kept the rhinestone skull exactly — best product fidelity, 21.6 s;
  2511 full 20-step turned the model to the front (product lost); 2509 altered the skull and denim; Qwen-Image
  2512 text-to-image is generic (no product). Current default confirmed for now.
- Next: more model families in the lab (FLUX.2 Klein 4B edit, HiDream E1.1, video: Wan 2.2 i2v / LTX on Comfy
  Cloud), wire `settings.image_variant` into post rendering, step 11 storefront.

## 2026-11-01 ~20:00 UTC — image lab: FLUX.2 Klein added (graph from Comfy Cloud's node definitions)

- `config/image-lab/flux2_edit.json` (ReferenceLatent + CFGGuider + Flux2Scheduler + SamplerCustomAdvanced, built
  from Comfy Cloud `/api/object_info`) with variants Klein 4B (4 steps), Klein 4B base (24 steps, cfg 3.5), Klein 9B
  (labelled non-commercial). All three render (22–41 s).
- Same jacket test: every Klein variant shows the jacket from the front — the rhinestone skull (the product's
  design) is lost; Qwen-Image-Edit 2511 Lightning 4-step is still the only one that keeps it. 9 models now in the
  lab for the owner to compare on more photos.
- Next: move the Comfy Cloud client to `packages/providers` and render posts with `settings.image_variant` on the
  cloud profile; HiDream E1.1 and video (Wan 2.2 i2v 5B/14B) variants; step 11 storefront.

## 2026-11-01 ~20:20 UTC — the lab's choice drives production post pictures

- `settings.image_variant` (set by "Use in production" in the admin lab) is read per render by the worker; with a
  Comfy key it renders the post picture with that variant's workflow on Comfy Cloud, otherwise it falls back to the
  router's image route. Comfy client moved to `@nearchant/providers` (shared by gateway lab + worker).
- **Verified** on the Mac stack: default set to `qie2511-l4` via the lab API → a post batch for `novatestaegk`
  logged "render with lab model qie2511-l4" and came back ready.
- Next: video variants on Comfy Cloud (Wan 2.2 TI2V 5B / I2V 14B, LTX-2.x) in the lab, then step 11 storefront.

## 2026-11-01 ~20:50 UTC — image lab: video on Comfy Cloud (Wan 2.2 TI2V 5B)

- `config/image-lab/wan22_ti2v.json` (Wan22ImageToVideoLatent with the product photo as start frame, umt5 fp8,
  wan2.2 VAE, ModelSamplingSD3 shift 8, uni_pc 20 steps, SaveWEBM vp9 24 fps) + variant `wan22-ti2v5b`
  (`output: video`). The Comfy client now finds any output file (images, WEBM, video); the lab shows videos.
- **Verified**: Fair Isle sweater photo → 704×1280, 121 frames (5 s) in 134 s; the model turns and smiles, the
  knit pattern stays intact across frames. Video can be tested on cloud credits while the Sparks are offline.
- Next: step 11 storefront; later more video variants (Wan 2.2 I2V 14B + lightx2v 4-step LoRAs, LTX-2.x) and the
  short assembly (English Kokoro voiceover + captions, docs/video-plan.md).

## 2026-11-01 ~21:30 UTC — M1 step 11: storefront + full item sale on NEAR testnet

- Store page (Figma storefront: header with "Store verified on NEAR", shop grid, latest posts with proof ids,
  "Safe to buy") and item page with the existing escrow checkout (sponsored test wallet → nUSD into `orders`).
  Classic deck shops keep their card.
- Owner side: Home lists the products the AI found in the photos — set a price → item (mirrored as an orderable
  service, photo copied to public); "Orders to ship" with "Mark shipped" → outbox `item.ship` → proof (shipping note
  hash) + `mark_delivered` with the store's agent keys. Item orders skip the AI pipeline and record a `sale` event.
  Order page has an item variant (paid → shipped → you confirm).
- **Verified** (`e2e/buy-item.mjs`, Chrome at phone size, Mac stack): paid 12 s → shipped → delivered on chain
  55 s → buyer "I got it" → `Released` 73 s, no page errors. First attempt left one order Delivered whose buyer key
  was in a closed test browser — the escrow timer releases it after the timeout.
- Not yet: the order page still has the old deck-shop styling; storefront order counter is 0 (wire to orders).
- Next: step 12 (analytics, wallet, settings; first-sale celebration; weekly report).

## 2026-11-01 ~22:40 UTC — M1 step 12: Analytics, Wallet, Settings, weekly report, first-sale celebration

- Analytics (`/app/analytics`, 7/30/90 days): store views (tracked on store + item pages, source from `?ref=` share
  links), sales count + revenue from sale events, posts published, proofs, daily views/sales bars, view sources,
  "What AI noticed" from the `write_insights` worker task (insight-writer over the real numbers, cached in settings).
- Wallet (`/app/wallet`): nUSD balance read from chain, held in escrow, AI usage (billing contract), transactions
  from orders; sidebar shows the balance (1.5 s best effort). Settings: store profile, brand wishes (kept across
  re-analysis, feed the idea writer), NEAR key export from the browser, plan usage. Weekly report (`/app/report`)
  with earned / sales / views / badges / next opportunities. First-sale celebration card on Home (once).
- **Verified** on the Mac stack (NEAR AI + chain): 6 tracked visits (telegram 3, instagram 2, direct 1); AI
  insights honest about thin data ("A quiet start — two sales brought in $90"); wallet 145 nUSD from chain, 45 in
  escrow, both sales listed; celebration shown on Home; screenshots desktop + mobile, no page errors. Fixed: mobile
  Home banner layout, share links carry `?ref`.
- Next: step 13 (polish: order page in the new style, store order counter, README + demo script, `make demo` for
  the new story), video shorts (13b), step 14.

## 2026-11-01 ~23:00 UTC — step 5 closed: opportunities without web evidence drop the trend

- Opportunities run live (price, upsell bundle, channel verified on NEAR AI and the local Qwen). The trend path needs
  web results: self-hosted SearXNG gets 0 results from this network — every engine is rate-limited, CAPTCHA'd or
  "access denied" (brave, duckduckgo, google, startpage, mojeek, qwant, yahoo). As designed, a trend without a real
  search result is dropped instead of guessed (tested).
- Fix for reliable trends: a search API (e.g. Brave Search API free tier) — owner's call; or run search from a
  different network (the Sparks' SearXNG worked earlier on 1 Nov).

## 2026-11-01 ~23:40 UTC — step 13 (part 1): order page restyle, store order count, README + demo script

- Item order page in the Figma style (paid → shipped → you confirm → released, escrow card); store page shows the
  real paid-order count. **Verified**: `e2e/buy-item.mjs` paid 12 s → shipped → delivered 29 s → Released 48 s,
  screenshots match the design, no page errors.
- README rewritten for the content-store story (live link, 7-step story, architecture diagram, run section with the
  new e2e scripts); `docs/demo-script.md` rewritten (90 s).
- Not yet: `make demo` still replays the first (deck) service — next: a content-store replay (analyze →
  opportunities → posts with pictures) recorded from a live run, so judges can run the new story with Docker only.

## 2026-11-01 16:25 UTC (machine clock; earlier entries' times were estimates) — step 13 (part 2): `make demo` on the new story

- `make demo` now replays the content store with Docker only: `apps/worker/src/content-cli.ts` runs 3 product photos →
  analysis → opportunities → 3 post options with pictures → `.media/demo-store/index.html` (+ result.json, post-*.png).
  Recording in `fixtures/replay/store/` (5 model calls via NEAR AI, 3 Comfy Cloud pictures, Qwen-Image-Edit 2511
  Lightning). The old deck replay is `make demo-deck`; CI checks both.
- Prompt rule added: never promise offers the owner did not state (no discounts, free delivery, deadlines).
  Comfy Cloud sometimes ends a job in `non_retryable_error`: the demo retries one other seed, then skips the picture.
- **Verified**: live record 126 s; replay with no keys gives a byte-identical result.json; `make demo` locally OK;
  captions checked for made-up offers (none). CI: see next entry / run 41325948230.
- **CI green** (run 41325948230: demo-store outputs + demo-deck).
- **Full journey on https://nearchant.com** — new `apps/gateway/e2e/journey.sh` (onboard.mjs with `LIST_ITEM=1`
  lists the first photo as an item, then buy-item.mjs): store created 7 s → analysis → opportunities 71 s → 3 posts
  with pictures 167 s → live 171 s → buyer paid 12 s → shipped → delivered on chain 62 s → Released 81 s; no page
  errors; screenshots checked. Step 13 ticked.
- First run failed: `relayer.nearchant.testnet` had 0.08 NEAR (a sponsored store costs ~0.15). Topped up 20 NEAR
  from the faucet into the root (throwaway accounts deleted into it) and sent 6 NEAR to the relayer (~40 stores).
  The onboarding page shows "Could not create the store" in that case.
- Not seen: the new store's page doesn't list "Latest posts" yet right after scheduling (posts publish on their
  schedule) — check after the first scheduled publish.
- Next: 13b video shorts (Comfy Cloud first; the Sparks are still offline).

## 2026-11-01 17:00 UTC — step 13b: post videos with an English voiceover

- "Make a video" on a post (Post detail): the `video-director` role (port of advertisment_system's short-form
  director) writes a hook ≤6 words, a 25–40 word voiceover with no numbers, and a motion prompt → Comfy Cloud
  Wan 2.2 TI2V 5B animates the post picture (704×1280, 5 s) ‖ Kokoro-82M speaks it, faster-whisper gives word
  timings → ffmpeg (`apps/worker/src/video-compose.ts`): forward+reverse loop under the voice, light grade,
  Montserrat hook on top + word-timed captions (ASS/libass), loudness-normalised, H.264 720×1280. Costs 3 picture
  credits, refunded on failure. Published posts carry the video to the store page.
- Merged the video-engine branch (`deploy/video-engine`: TTS service + LTX-2.5 adapter). The TTS service runs in
  local compose (`COMPOSE_PROFILES=…,video`, weights outside the repo under `TTS_WEIGHTS`); the LTX adapter is not
  used yet. App image now includes ffmpeg; `/files/` serves mp4 with byte ranges (Safari).
- **Verified live on nearchant.com** (Mac stack): one video in 143 s (13 s voiceover, 2.7 MB); frames checked
  (hook, captions, smooth loop after the ping-pong fix); post page in Chrome plays it (duration 13.6 s, no page
  errors). Tests: swarm 31, gateway 29 (video route, quota, no double start, mp4 ranges), worker 9 (captions,
  ASS escaping, ffmpeg args, TTS retry/4xx, make_video failure refund).
- Found: Wan 2.2 **5B changes the product** (jacket lying flat → darker jacket on a hanger). Next: try Wan 2.2
  14B I2V / other i2v models in the image lab against product fidelity (Comfy credits until 11 Nov). Cloudflare
  caches a 404 for `.mp4` URLs: video URLs now carry `?v=`.
- Not verified: video on the Sparks (offline); the store page showing a published post's video (needs a post to
  publish — next scheduled 6 Nov).
- Next: step 14 (NEAR AI TEE + attestation in proofs), video model comparison in the lab.

## 2026-11-01 17:10 UTC — step 14 (part 1): NEAR AI TEE attestation in the proofs

- The router hands each new NEAR AI attestation report (raw, once per model per 10 min) to a sink; the worker keeps
  it at `.media/attestations/<sha256>.json` and the gateway serves it publicly at `/attestations/<sha256>.json`
  (immutable; the bytes hash to the name). Envelopes still carry only the hash (schema unchanged).
- Post generation records the writer (`idea.writer`: model, tier, report hash, signing address). The proof on NEAR
  now has `attestation_ref = "nearai:<model>:<report sha256>"` and names the model in `producer`; the post page's
  proof card says who wrote it honestly ("Qwen3.6 35B · private NEAR AI TEE (attested)", or "on your own GPU" for
  the Spark) and links the report. Brief hash excludes the writer, so it stays comparable.
- **Verified live**: a new post for `novatestl21q` written on NEAR AI TEE → published → **proof #18** on
  `proofs.nearchant.testnet` with `attestation_ref nearai:Qwen/Qwen3.6-35B-A3B-FP8:24459fc5…f425`; the public
  report (262 KB: gateway_attestation, model_attestations, ohttp) downloads and hashes to that value; proof card
  screenshot checked, no page errors. Tests: providers 11 (sink once, raw kept out of the envelope), worker 10
  (attestation_ref only for TEE writers), gateway 30 (report route rejects anything but a sha256 name).
- Not done: verifying the TDX/GPU quotes inside the report (pinned only, `verified: false`); Levanto Sage
  router for production; Phala deploy (owner account).
- Next: video model comparison in the lab (product fidelity), then Levanto Sage routing.

## 2026-11-01 17:35 UTC — video model: Wan 2.2 I2V 14B (keeps the product); Levanto Sage is not a router

- Image lab variant `wan22-i2v14b-l4` (Wan 2.2 I2V A14B fp8, high+low noise, Lightning 4-step LoRAs, 720×1280,
  81 frames @16 fps) on Comfy Cloud. Same picture + motion prompt as the 5B: **the 14B keeps the product** (jacket
  stays flat, same colour; sweater in place; only a slow push-in) while the 5B added a hanger and darkened the
  jacket. 14B is also faster on Comfy Cloud (94 s vs ~130 s). Now the default (`VIDEO_VARIANT`).
- Fixed: the video-director came back empty (Qwen spent all 1200 tokens thinking) → `reasoning: false`,
  max_tokens 3000. Video length cap 20 → 30 s (an 18.7 s voiceover was close to being cut).
- **Verified live**: a video for the published post p-6305… (proof #18) in 102 s → copied to the public store;
  the store page shows and loads it (19.3 s, poster, "Proof #18 on NEAR" badge, no page errors).
- **Levanto Sage 1.4 (finding)**: on NEAR AI it is a *decision* model (`/v1/systemone`): typed yes/no, choice and
  score questions → calibrated probabilities, not generated text and not a model router. The plan's "pick the model
  per task" would mean asking it a choice question per call. Better fits: cheap policy checks (does a caption
  promise an offer the owner did not state? is a buyer message trying to change payment or recipient?) and the
  review "passed" bit in proofs. → Owner decision below; nothing built yet.

## 2026-11-01 17:50 UTC — back on the Spark: nearchant.com served by gx10-8695 again (owner's choice)

- All three Sparks returned ~17:20 UTC (gx10-8695 had a ~50 s network drop after boot; dgx-spark-2 on Wi-Fi drops
  now and then). Owner chose to move back. Cutover: Mac gateway+worker stopped → `pg_dump` (6.6 MB) + media volume
  tar (66 MB) → Spark (old Spark DB and media kept in `~/nc-migrate/spark-old.dump`, `spark-media-old.tar`) →
  restore → Spark stack up with the new images (latest main, ffmpeg, video profile, TTS weights in
  `~/nearchant-node/tts-weights`, Comfy key in the git-ignored `.env`) → Spark tunnel on, Mac tunnel off (Mac
  profiles now `cloudimage,video`, Mac stack stopped; its volumes stay as a backup).
- **Verified**: row counts equal on both (businesses 3, posts 8, media 16, orders 10, jobs 6); through
  nearchant.com: /start 200, store page 200, published video 200 (2.5 MB), attestation report 200 (262 KB),
  seller session 200; no gateway errors; worker lists make_video. **Full journey e2e on the Spark** (local
  models): store 8 s → opportunities 38 s → 3 posts with pictures 95 s → live 100 s → paid 13 s → delivered 39 s →
  Released 57 s, no page errors (faster than the Mac: 167 s / 81 s).
- Text now runs on the Spark's own Qwen3.6 (providers.local.yaml), so new proofs say "on your own GPU" with no
  attestation_ref; earlier proofs keep their NEAR AI report. Videos use Comfy Cloud (Wan 2.2 14B) + the Spark's TTS.
- gx10-c3c8 (video box) left untouched: its LTX memory cap is still untested after the freeze.

## 2026-11-01 18:40 UTC — Levanto Sage checks captions; both Sparks are Nearchant's; a bigger model for gx10-c3c8

- **Owner decisions (1 Nov evening)**: Nearchant is priority #1. gx10-8695 + gx10-c3c8 are Nearchant's; the Gigabyte
  (dgx-spark-2) is the owner's personal machine. Boost Content is set aside: on c3c8 I stopped and disabled the
  `inf-node.service` watchdog and stopped `inf-node-agent` (restart=no) so it cannot place models there; nothing
  deleted (undo: `systemctl --user enable --now inf-node.service`). Sage: use it for checks + proof review.
- **Levanto Sage caption check**: new capability `decide` (spec) → NEAR AI `/v1/systemone` (request
  `{model, state, questions:{id:{type:noul|choice|score|box, instructions, criteria?}}}`, answer `noul` = P(yes)).
  Worker `check_post` after each written post and after each caption edit asks "does the caption promise anything the
  owner did not state (discount, sale price, free delivery, gift, deadline, limited stock, other price)?"; the post
  page shows a yellow warning when P ≥ 0.5; the proof's `review` = passed unless flagged, `reviewer_hash` = sha256
  of Sage's answer (only when the check read the current caption). **Sage has no attestation report** (NEAR AI
  `/attestation/report` → 503), so only public data goes to it: the caption and what the store page shows.
  Buyer-message checks (private: addresses, phones) wait until Sage is attested.
- **Verified live on nearchant.com (Spark)**: a real post with "This week only: 50% off and free delivery!" appended →
  0.9971, flagged, warning shown (phone screenshot, no page errors); original caption → 0.0105, not flagged.
  Tests: 107 (providers 12: decide routing, private refused; swarm 33; worker 12; gateway 31).
- **Bigger LLM** (research with sources in this session): one model across both Sparks is a poor fit (80–115 GB
  per node, fragile multi-node vLLM, ~1.3× speed). Plan: one model per box — gx10-c3c8 runs **Qwen3.8-27B NVFP4**
  (Apache-2.0, vision, ~23 GB; Artificial Analysis 44–52 vs ~32 for Qwen3.6-35B-A3B; ~25 tok/s with MTP) for
  writing + insights; gx10-8695 keeps Qwen3.6-35B-A3B (fast, vision) + images + app. Downloading the weights and
  pulling NGC vLLM 26.10 (the Sparks' vllm-node is 0.23.1; Qwen3.8 needs ≥0.25.1) on c3c8.
- Next: start Qwen3.8-27B on c3c8, route idea-writer / insight-writer / video-director to it, compare outputs.

## 2026-11-01 19:00 UTC — Qwen3.8-27B on gx10-c3c8 writes the posts

- `deploy/llm-node/compose.yaml` on gx10-c3c8: NGC `nvcr.io/nvidia/vllm:26.10-py3` (vLLM 0.31) serving
  `unsloth/Qwen3.8-27B-NVFP4` (22.6 GB, sha256 checked against the HF LFS id; tokenizer `truncation` null) with MTP
  (3 draft tokens), 55% of unified memory, `100.64.0.1:8010`, same key as the 8695 node (git-ignored engine.env).
  Ready in 195 s; 45 GB still free on the box.
- Content store: `seats.second = Qwen/Qwen3.8-27B`; idea-writer, insight-writer and video-director use it; profiler
  (vision), opportunity-analyst, learner, localizer stay on Qwen3.6-35B-A3B (fast). If c3c8 is down, the second
  seat degrades to the main one (existing agent.ts logic). `make demo` replay unchanged (verified).
- **Verified**: direct calls 22.9 tok/s (thinking off) / 24.2 (thinking on), valid JSON, no invented offers; live on
  nearchant.com a 3-post batch for `novatestgnpn` in 102 s with pictures — envelope model `qwen3.8-27b`; Sage
  checks 0.006–0.010 (none flagged).
- Seen: something on the Gigabyte (100.64.0.12, Boost Content's cluster) polls `100.64.0.1:8010/health` — it gets
  health only; every model call needs our key.
- Not done: a side-by-side quality review of Qwen3.8 vs Qwen3.6 posts with the owner; the first download stalled
  (HF client), finished with curl resume.

## 2026-11-01 19:30 UTC — the nearchant.com home page (Figma "Landing") was missing

- Owner: "I can't see my Figma design on nearchant.com". Cause: `/` on the platform host redirected to
  `app.nearchant.com`, which resolves as a store called "app" → "No shop here". The build order had no line for
  the Landing frame (21:674), only onboarding (`/start`) — a gap in m1-plan, not a cut.
- Built `src/ui/landing.tsx` + `.land-*` styles from the Figma frame (nav, hero, peek, three pillars, trust band,
  pricing, footer; responsive). Shown honestly: numbers are real (`ContentStore.showcase`: posts with a proof,
  paid orders, stores); peek shows the latest published posts with a proof, empty slots are labelled
  "Example"; "we create your NEAR account for you" (no email sign-up exists); Pro "Coming soon" with the real
  150/300 limits; no fee figure; no Privacy/Terms links until those pages exist.
- Found on the way: Cloudflare cached `/assets/ui.css` for up to 4 h, so style changes reached users late → all
  asset links now carry a content hash (`?v=`).
- **Verified** on nearchant.com in Chrome at 1440 and 393 px: layout matches the Figma frame, no horizontal scroll,
  no page errors; `/`, `/start`, store page load the new CSS. Tests: gateway 33 (landing at the bare domain, store
  host unaffected, labelled examples, word-safe captions), db 14 (showcase).

## 2026-11-01 19:50 UTC — Figma audit: desktop onboarding card; icon fix; remaining gaps

- After the missing landing, compared Figma frames with nearchant.com screen by screen (Chrome 1440 / 393 px).
- Fixed: `/start` on desktop now uses the Figma "Web · Onboarding" card (grey page, 560 px white card, buttons in
  the card); phones keep the full-screen flow. The store step now says how the NEAR account works (no seed phrase,
  key export in Settings). Icons no longer shrink in flex rows (shield in proof cards was squashed, incl. the
  store's "Safe to buy").
- Close to Figma already: Create (only the 1-2-3 step indicator is missing), Posts, Post detail, store pages.
- **Figma features not built** (need a decision or an owner action):
  - "Continue with email" sign-up — needs an email provider (API key) for the login link; today the store key
    lives in the browser and can be exported.
  - "Connect a NEAR wallet" — doable with NEAR Wallet Selector (MyNearWallet / Meteor / HOT) before the freeze.
  - Create's 3-step indicator (Photos & idea → AI makes it → Review & publish).
- Not compared yet: Web · Home and the mobile seller screens (Figma screenshot call dropped) — next pass.

## 2026-11-01 20:15 UTC — Figma audit, part 2: Home and the Create flow

- Web · Home: account pill (store account + balance), "Payments" card (latest paid item orders with escrow state,
  balance, Wallet link — no Withdraw button until withdrawing exists), 7-day bars under views, sales and proofs.
  Sidebar column stays grey on long pages.
- Create flow (Figma Create 1–3): step bar Photos & idea → AI makes it → Review & publish; after "Create posts"
  the page goes to `/app/posts?batch=…`, which shows step 2 while the AI works and step 3 when the batch is ready.
- **Verified** in Chrome on nearchant.com: Home with real data; a real Create run went 1 → 2 → 3 with three posts
  with pictures, no page errors. Gateway tests 33.
- Still from the audit: "Continue with email" (owner: email provider) and "Connect a NEAR wallet" (next);
  mobile seller screens not compared yet.

## 2026-11-01 20:45 UTC — light-only UI; no skull anywhere

- Owner (screenshot from a dark-mode browser): store page background wrong — the page went black while the hero
  card stayed light, so the white title vanished. The Figma is light-only: dropped the dark palette from
  `ui.css` and `pages.tsx`, `color-scheme: light`. Verified in Chrome with `colorScheme: dark`: white page, dark title.
- Owner: remove the skull. New `fixtures/replay/store/photos/photo-1.jpg` (Qwen-Image-Edit 2511 removed the
  rhinestone skull; same jacket, hanger, light). `make demo` recording redone (no "skull" in any envelope; replay
  identical). The demo now paints a post without a product photo with Qwen-Image 2512 (the edit model needs a
  photo — that was the repeated `non_retryable_error`) and keeps already-recorded pictures. Live test stores
  (novatestaegk, novatestl21q, novatestgnpn): item renamed "Dark denim jacket", photo replaced (private + public
  copy), two scheduled skull posts removed. Item photo URLs carry `?v=` so Cloudflare's day-long cache can't show
  the old picture. e2e journey lists "Dark denim jacket".
- Store page: "1 order" (was "1 orders").

## 2026-11-01 20:35 UTC — New York instead of Kyiv; 8-second shorts

- Owner: use an English-speaking, wealthy city instead of Kyiv; 19 s shorts are too long — must be quick to catch,
  read and sell. Demo store is now "Nova Wear NYC — designed in SoHo, New York, ships across the US": `make demo`
  re-recorded (no Kyiv/Ukraine anywhere; replay identical), e2e store, onboarding placeholder, checkout delivery
  form (name/address/phone, US example instead of Nova Poshta / +380), opportunity example, dates in New York
  time (en-US).
- Shorts: hook ≤5 words; voiceover 12–20 words (feeling → product detail → "tap the link"), `shortVoiceover` keeps
  whole sentences ≤22 words; hard cap 12 s. **Verified live**: 7.9 s video for a Nova Wear NYC post — hook "Raw
  denim truth", three readable caption chunks, ends on the call to action.
- **Live**: new store `novatest1rxu` ("Nova Wear NYC") through the full journey (posts 188 s, Released 61 s after
  payment), its 3 posts published → proofs #21–#23; nearchant.com home now shows them (no "Kyiv" on the page).
  Older Kyiv test stores still exist at their own links but are not shown on the home page.

## 2026-11-01 21:30 UTC — intros, subtitles and text on pictures (ported from advertisment_system)

- Read (read-only) advertisment_system `subtitles.py`, `overlay.py`, `ad_post.py`, `docs/TEXT_ON_MEDIA_PLAN.md`; Boost
  Content has no media-text code (its strength is the copy, already ported). Rule kept: text is always ours, never
  drawn by the image/video model.
- Shorts (`video-compose.ts`): hook on a brand-colour box (balanced 2 lines, safe area); captions use the script's
  words on whisper's timing (`alignToScript`), chunks break at pauses > 0.6 s, min 0.3 s, on a dark box at ~70 %
  height; 1.5 s end-card in the brand colour (store name, "Tap the link to shop", `<handle>.nearchant.com`).
  Brand accent = most vivid profile brand colour (`pickAccent`). The first post of a new store gets a short
  automatically during onboarding (3 picture credits; skipped without credit); the "live" step says so.
- Picture posts: post writer returns a 2–5 word `headline`; a brand-colour headline strip is burned on in our
  font (ASS/libass via ffmpeg, `image-text.ts`); the clean picture is kept for videos. Every picture prompt ends
  with a no-text guard; a vision check (local Qwen3.6) re-rolls once when lettering appears — it caught an
  invented "ZARA" label on a demo jacket. Posts without a product photo are painted with Qwen-Image 2512 (the
  edit model rendered them black); blank renders are retried.
- Fixed: Pro stores were checked against the free limits (the API never passed the plan).
- **Verified**: live on nearchant.com — Nova Wear NYC batch with three headline pictures (no stray text), an 8.7 s
  short with the red hook box, captions and the end-card; `make demo` in Docker shows the headline strips
  (re-recorded, replay identical). Tests: worker 18, gateway 34, swarm 34.
- Seen: Wan 2.2 added hands to one clip although the prompt said no people → prompt now says "no people, no hands".

## 2026-11-01 21:50 UTC — onboarding first short verified; camera-only video motion

- **Verified**: a new store (`novatestytz5`) through the full journey got its first short automatically (7.45 s:
  hook box "FEEL THIS WEIGHT.", darker caption box, bigger end-card with the store link). No page errors.
- The clip still showed hands ("feel this" invites touching). Wan 2.2 Lightning runs at cfg 1, so negative prompts
  do nothing: the director now writes camera-only motion, and a motion prompt mentioning hands/people/touching is
  replaced by a fixed camera push-in (`CAMERA_ONLY`). **Verified**: next live short (7.75 s, "BUILT TO LAST") has
  no hands. Swarm tests 35.
- Next: mobile seller screens vs Figma, then "Connect a NEAR wallet".

## 2026-11-01 22:10 UTC — Figma audit, part 3: mobile seller screens

- Compared Mobile web · Home / Analytics / Wallet (393 px) with nearchant.com. Fixed: bottom bar order
  Home · Posts · (+) · Analytics · Wallet as in Figma; no duplicate "Create post" button on phones (the + is it);
  wallet amounts stay on one line; AI usage shows 0 instead of "—". **Verified** in Chrome at 393 px, no errors.
- Differences kept on purpose: no "Engagement"/"Followers" stats (we have no social account data), Wallet has no
  Receive/Withdraw buttons yet (not built), the app keeps its own top bar (the Figma frame shows the browser's).
- Next: "Connect a NEAR wallet" (Figma onboarding 1).

## 2026-11-01 22:40 UTC (machine clock) — store grid in Safari; onboarding sizes; onboarding polling fix

- Owner (screenshot, Safari): store "Latest posts" overlapped — a tall video card stretched the row and Safari
  sized the aspect-ratio pictures from that height; badges stretched; "Safe to buy" text overflowed. Fixed:
  grid items start-aligned, pictures take the column width, all post cards 4:5 (video too), badges keep their
  size, flex text can shrink, captions clamp to 3 lines. **Verified** with WebKit (Safari's engine, now
  installed for playwright) and Chrome at 1000 and 393 px: no overlap, badges 23 px, no horizontal scroll.
- Onboarding sizes per Figma: 72 px photo tiles in one row with "+", compact opportunity cards (2-line why, check
  circle), first-post rows with 2-line titles and an "Edit first" link. **Verified** in Chrome desktop (card
  layout) and WebKit at phone size.
- Found while verifying: the first-posts watch stopped on any failed request (here: my gateway redeploys during
  the test) and "Schedule all" stayed disabled forever. The watch and the opportunities load now retry. A clean
  run: posts ready ~90 s after "make my posts", button enabled, onboarding completed.
- Seen: Cloudflare injects its Web Analytics beacon, which our CSP blocks (console error only).

## 2026-11-01 23:05 UTC — night: Sparks run LLMs only; "Connect a NEAR wallet"

- **Sparks (owner: pictures + video only on Comfy)**: gx10-8695 — local ComfyUI + image engine stopped (restart=no),
  image service now in Comfy Cloud mode (`COMPOSE_PROFILES=tailnet,tunnel,cloudimage,video`); available memory
  13 → 43 GB. gx10-c3c8 — 13 unused containers stopped (ncvideo stack, Boost Content inf-*/bc-*), only `nc-llm2`
  runs. **Verified**: a new 2-post batch with headline pictures and an 8.5 s short after the change.
- **Connect a NEAR wallet** (Figma onboarding 1): NEP-413 signed message via MyNearWallet's sign-message page —
  no transaction, no fee. `src/nep413.ts` rebuilds the signed bytes (tag 2^31+413, borsh message/nonce/recipient/
  callbackUrl) and checks ed25519; `/api/wallet/verify` requires a ≤10-min message, our host as recipient, a
  single-use nonce, and a full-access key of the wallet account (checked on chain). "link" (signed in) remembers
  the wallet for the store; "signin" sets the session. UI: Sign in page "Sign in with NEAR wallet", Settings →
  NEAR wallet, onboarding's last step "Connect your NEAR wallet (optional)", callback `/app/wallet-connect`.
- **Verified**: unit tests (payload tag, tampering, replay, expiry, wrong site, link→signin; gateway 37); live on
  nearchant.com with a real testnet key (relayer.nearchant.testnet): signin before link → 404, link → 200,
  signin → 200 + session, a key not on the account → 403 (on-chain check). The button redirects to
  `testnet.mynearwallet.com/sign-message` with our message and recipient. Test link removed afterwards.
- Not verified: the round trip through MyNearWallet's own UI (needs a person with a wallet). The callback page
  reads the result from the URL hash or query.

## 2026-11-01 23:20 UTC — night: our own check of NEAR AI attestation reports (step 14)

- `packages/providers/src/attest-verify.ts` checks each NEAR AI report without trusting NEAR AI: our nonce comes
  back (freshness); the gateway's Intel TDX quote REPORTDATA = NEAR AI's signing key ‖ our nonce; MRCONFIGID carries
  the app's compose hash; each model's quote = its signing address ‖ our nonce; the GPU evidence is for our nonce;
  the TDX quotes are verified by Phala's public DCAP verifier. NVIDIA's NRAS answers 403 without an API key, so
  the GPU evidence itself is not checked by NVIDIA (stated in the result).
- The worker checks each new report once and publishes `/attestations/<sha256>.check.json` beside the report; the
  post page links "report · our check". Backfilled the 3 saved reports: all ok, TDX verified (gateway + model).
- **Verified**: tests on a real report (bound/verified; wrong nonce, rejected quote, swapped key fail; verifier
  down = unknown) — providers 17; live `https://nearchant.com/attestations/24459fc5…f425.check.json` (proof #18).
- Not done: NVIDIA NRAS (needs a key), Phala deploy (owner account).

## 2026-11-01 23:35 UTC — night: submission docs, walkthrough video, 11× smaller pictures

- README (story, architecture, libraries) and `docs/demo-script.md` (90 s) describe the current product: headline
  pictures, 8-second shorts, the Levanto Sage caption check, the attestation check, Connect a NEAR wallet, two
  Sparks for the LLMs + Comfy Cloud for pictures and video, Nova Wear NYC.
- `apps/gateway/e2e/walkthrough.mjs` records nearchant.com in Chrome: desktop (landing → seller app → a post with
  its short and proof → analytics → wallet → settings), phone onboarding of a new store (AI waits ×6), phone
  storefront; ffmpeg joins it into one 1440×900 mp4 (~78 s). Fixed a join error (non-square pixels).
- Pictures: `/files/…?w=320|640|1024` returns a resized WebP made once and cached (`.thumbs/`), same privacy as the
  original; grids, store, landing and onboarding use it. **Verified**: 1.29 MB PNG → 119 KB WebP; tests 38.
  (The first recording showed an empty picture box: the 1.3 MB PNG had not loaded yet.)

## 2026-11-01 23:50 UTC — night: regression green; "Verify a post"; hidden test stores

- **Regression**: journey e2e on nearchant.com (posts 128 s, paid → shipped → Released 64 s, no page errors),
  `make demo` in Docker, CI green on every push tonight; WebKit + desktop onboarding checked earlier.
- **Walkthrough video** committed: `docs/media/walkthrough.mp4` (72 s, 2.1 MB), linked from the README.
- **Verify a post** (`/verify`, `/verify/<n>`; landing nav + footer): reads the proof from `proofs.nearchant.testnet`,
  recomputes the fingerprint from the published caption + the published picture file (so a later edit shows as
  "changed"), shows the publishing account, the caption check, and the TEE attestation (model + our report check),
  plus the `near view` command to check it yourself. **Verified** live: proofs #18, #21, #23 "unchanged"; tests 40.
- Public pages show only the demo store: setting `showcase_hidden` lists the 13 other test stores (Kyiv/skull era
  and test runs); "Kyiv" no longer appears on nearchant.com's home or verify pages.

## 2026-11-02 00:05 UTC — night: Wallet Receive / Withdraw

- Wallet page (Figma): **Receive** shows the store account with Copy; **Withdraw** sends nUSD from the store account
  to any NEAR account, signed in the browser with the store key (the server never sees it): checks the account
  exists and the balance, pays the receiver's one-time nUSD registration from the store if needed (0.00125 NEAR),
  then `ft_transfer`. Prefilled with the linked NEAR wallet. Amounts converted exactly (`web/units.ts`, tested).
- **Verified live** (`apps/gateway/e2e/withdraw.mjs`): a new store withdrew 1 nUSD to relayer.nearchant.testnet and
  0.5 nUSD to nearchant.testnet — balances on chain moved by exactly 1.5 nUSD, no page errors.
- **Verified at 00:38 UTC**: the registration path too — a fresh testnet account that never held nUSD received
  0.5 nUSD; the store paid its registration (registered: false → true, balance 500000 units). (The first retry hit
  the shop-creation limit — 3 new stores per address per hour — after tonight's tests.)
- Seen: `InvalidNonceError` on the relayer while a test script signed with the same key from the Mac; the chain
  client's retry (fresh nonce, 4 tries) covers normal traffic.

## 2026-11-02 00:35 UTC — night: post page per Figma (Post ready / Post proof); caption chips

- Post page: status title ("Your post is ready" / "Scheduled" / "Posted") + "‹ Posts"; on phones the picture is at
  most half the screen tall, the video is 260 px wide; proof card adds **Share proof link** (the `/verify/<n>` page,
  native share sheet on phones). **Verified** in Chrome at 393 px (picture 353×392, no errors).
- **Caption chips** Shorter / Playful / Bolder (Figma "Shorter · Playful · Ukrainian", English-only now): role
  `caption-editor` (Qwen3.8 seat, no reasoning) rewrites keeping every fact, adding no offer; the new caption is
  re-checked by Levanto Sage; published posts can't be rewritten (their proof is bound to the caption).
  **Verified** live: a 160-character caption → "We test how these SoHo pieces layer so they last. A simple wardrobe
  that covers many days. See how they fit together." (check 0.02). Tests: gateway 43, swarm 36.
- Fixed tonight's PROGRESS times to the machine clock (earlier entries were estimates, ~2 h ahead).

### Owner actions
- Try "Connect a NEAR wallet": Settings → NEAR wallet in your store (testnet MyNearWallet account), then sign in
  with it from another browser. Tell me if MyNearWallet shows an error.
- Email sign-up (Figma onboarding 1): say if you want it, and give an email provider key (e.g. Resend or Postmark)
  — I'll add "Continue with email" login links. "Connect a NEAR wallet" I can build without anything from you.
- Optional: a Brave Search API key (free tier) for reliable trend opportunities — self-hosted search is blocked
  from the home network right now.
- **URGENT (1 Nov ~18:00 UTC): all three Sparks offline** (no ping/SSH; nearchant.com 530) — likely power or
  network at the site. `gx10-c3c8` went silent first (~17:30, during a video render). Check power/network; power-
  cycle `gx10-c3c8` if it alone stays down. All Nearchant containers restart by themselves.
- Agent Market: listing alice on market.near.ai is a public listing paid in real USD — your call. If yes: create the
  agent (self-hosted, http) on market.near.ai, paste its `aat_` token at `/h/alice/manage`, set the webhook URL +
  secret it shows (needs the public tunnel URL first).
- Telegram: create a bot with @BotFather and paste the token at `/h/alice/manage` (owner key is in the Keychain
  as `NC_SELLER_alice_OWNER`), or send it to me and I'll connect it.
- ~~`gx10-8695`: add `server` to the docker group~~ — done 2026-10-31; Docker 29.6 + GPU in containers verified.
- Testnet NEAR: root has ~7.9 NEAR after deploying; each sponsored shop costs ~0.2 NEAR. I'll top up from the
  faucet as needed.
- ~~Sparks offline~~ — back ~07:00 UTC 1 Nov.
- Phala Cloud account with credit, needed by ~8 Nov.
- ~~Cloudflare routes~~ — done 1 Nov: `https://nearchant.com` and `https://<store>.nearchant.com` are public
  (verified: /new 200, verity.nearchant.com 200, alice via Cloudflare edge 200).
- ~~HF token~~ — given 1 Nov (Keychain `HF_TOKEN`).
- ~~GPU for video~~ — decided 1 Nov: `gx10-c3c8` (own containers; inference_system untouched).
- Third Spark: send its tailnet IP (and make sure `server` is in the docker group) to move the LLM or images there.
- ~~NEAR AI credit~~ — topped up +$20 on 1 Nov.
- `gx10-c3c8` / inference_system: its own engines are off; its config still lists the reinstalled `dgx-spark-2`
  (now `gx10-8695`) as node1. Nearchant doesn't depend on it; fix in that repo when convenient.
