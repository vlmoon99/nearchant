# Nearchant

[![ci](https://github.com/vlmoon99/nearchant/actions/workflows/ci.yml/badge.svg)](https://github.com/vlmoon99/nearchant/actions/workflows/ci.yml)

**Sell more, work less, get paid on NEAR.** An AI content manager for small sellers: it learns your store from a
few photos, finds ways to sell more, makes your posts, tells you what works — and your buyers pay you through
escrow on NEAR, with every post and every payment provable on chain.

Nearchant (NEAR + merchant) is open source (MIT). It combines the author's Boost Content product (photos → posts) with
NEAR rails: a NEAR account per store (made in the browser, no seed phrase), escrow for orders, prepaid AI billing,
and a public proof log.

> Built for the [NEAR Hackathon](https://nearhackathon.com) (Nov 2026). Tracks: **Agent Economy**, Private AI,
> Autonomous Business. Everything runs on **NEAR testnet** with a free test token (`nUSD`) — nobody pays real money.
> Live: **https://nearchant.com/start**

## The story (try it at nearchant.com/start)

1. **Onboarding (2 minutes, phone-first).** Say what you sell, add a few product photos. A NEAR account
   (`<store>.nearchant.testnet`) is created in your browser.
2. **AI learns the store.** A vision model reads the photos: products, style, buyers, what gets saves.
3. **AI finds ways to sell more** — trend (only with a real web source), price, upsell bundle, channel — each with
   an honest monthly estimate ("estimates, not promises").
4. **First posts in a minute.** Captions in the store's voice + AI pictures of the real product in new scenes
   (Qwen-Image-Edit keeps the product intact) with a short headline strip in the brand colour — text on pictures is
   always ours, never drawn by the model; a vision check re-draws pictures with stray lettering. **Levanto Sage**
   (NEAR AI) checks every caption for offers the owner never stated. The first post also gets an **8-second short**:
   hook on a brand-colour box, word-timed captions, an English voice, an end-card with the store link.
5. **Published post → proof on NEAR.** The store's own agent key writes a `proof-log` entry: fingerprint of caption
   + image, the AI that made it, the time, the caption check. When the text model ran in a NEAR AI TEE the proof
   cites its attestation report, and we publish **our own check** of that report (our nonce and NEAR AI's key bound
   into the Intel TDX quote, the quote verified by Phala's DCAP verifier).
6. **A buyer buys** on the storefront: free test wallet in the browser → `nUSD` into the `orders` escrow →
   the seller marks it shipped (recorded on NEAR) → the buyer confirms → the escrow pays the store.
7. **Your own wallet, optional.** "Connect a NEAR wallet" links the owner's MyNearWallet account with a signed
   message (NEP-413 — no transaction, no fee); after that it signs in to the store from any browser.
8. **Analytics + wallet.** Views by source, sales, AI insights over the real numbers, balances read from chain,
   first-sale celebration, weekly report. AI usage is metered and settled on chain (`billing`).

Three money flows, all on NEAR testnet: **buyer → seller** (`orders` escrow), **seller → platform** (metered AI in
`billing`, Merkle-batched), **agent → agent** (hiring under an on-chain spend policy in `escrow-policy`).

## Architecture

```mermaid
flowchart LR
  subgraph Web["nearchant.com (desktop + mobile web)"]
    O["Onboarding /start"]
    A["Seller app /app<br/>Home · Create · Posts · Analytics · Wallet · Settings"]
    S["Storefront /h/&lt;store&gt;<br/>shop · item · escrow checkout"]
  end
  subgraph Gateway["Gateway + worker (Spark or Mac, later Phala TEE)"]
    G["Hono gateway<br/>pages, JSON API, sessions"]
    Q[("Postgres<br/>stores, posts, events, queue, outbox")]
    W["Worker: analyze → opportunities →<br/>posts → render → publish"]
    R["Capability router<br/>privacy tiers + attestation"]
    L["Admin image lab (tailnet only)"]
  end
  subgraph Models
    LL["Two DGX Sparks (own GPUs)<br/>Qwen3.6-35B: vision, analysis<br/>Qwen3.8-27B: posts, scripts<br/>Kokoro voice + Whisper"]
    NA["NEAR AI Cloud TEE<br/>+ Levanto Sage checks"]
    CC["Comfy Cloud<br/>Qwen-Image-Edit, Qwen-Image,<br/>Wan 2.2 14B video"]
  end
  subgraph NEAR["NEAR testnet"]
    OR["orders (escrow)"]
    PL["proof-log"]
    BI["billing"]
    HN["handles + nUSD"]
  end
  O --> G
  A --> G
  S --> G
  G --> Q --> W --> R
  R --> LL
  R --> NA
  W --> CC
  L --> CC
  S -- "pay nUSD" --> OR
  W -- "post proof (store's agent key)" --> PL
  G -- "ship → mark_delivered" --> OR
  Q -- "usage batches (Merkle root)" --> BI
  G -. "new store" .-> HN
```

## Live on testnet

| What | Where |
|---|---|
| Platform root + handle factory | [`nearchant.testnet`](https://testnet.nearblocks.io/address/nearchant.testnet) |
| Test token (faucet) | `nusd.nearchant.testnet` |
| Escrow for buyer payments | `orders.nearchant.testnet` |
| Prepaid inference balances | `billing.nearchant.testnet` |
| Proofs of posts, deliveries and shipments | `proofs.nearchant.testnet` (`get {proof_id}`) |
| Agent hiring budgets | `escrow.nearchant.testnet` |
| Example stores | any `<store>.nearchant.testnet` created at nearchant.com/start |

## Run it

### 0. The one-command demo (Docker only — no accounts, no GPU, no keys)

```bash
make demo          # the content store: open .media/demo-store/index.html
```

Replays one recorded live run of the content-store story for **Nova Wear NYC** (a small SoHo, New York shop; NEAR
AI TEE text + vision, Comfy Cloud pictures): 3 product photos → what the AI found → ways to sell more → 3 post
options with AI pictures of the real products and their headline strips. It takes a few seconds after the image builds and writes
`.media/demo-store/{index.html, result.json, post-*.png}`. `make demo-deck` replays the first demo service (an
investor-deck agent pipeline) the same way.

### 1. Contracts only (no setup beyond Rust)

```bash
cargo install cargo-near   # once
make test-contracts        # builds 6 contracts, runs the near-workspaces sandbox tests
```

### 2. Everything locally

Requirements: Docker, Node 24 (`corepack enable` for pnpm), Rust + `cargo-near`.

```bash
pnpm install
docker compose -f deploy/local/compose.yaml up -d db     # Postgres + pgvector
pnpm -r build
pnpm -r test                                             # unit + integration tests (Postgres needed for packages/db)
```

### 3. The live product on your machine

`docker compose -f deploy/local/compose.yaml up -d` runs gateway, worker, Postgres, renderer and search
(`deploy/local/.env.example` lists the keys; `config/providers.local.yaml` = own GPU, `providers.mac.yaml` =
NEAR AI TEE text + Comfy Cloud images). Then:

- `http://localhost:8787/start` — onboarding: create a store, add photos, get opportunities and first posts.
- `http://localhost:8787/app` — the seller app; `http://localhost:8787/h/<store>/` — the storefront.
- Browser tests (installed Chrome; `ENGINE=webkit` for Safari's engine, `VIEWPORT=1440x900` for desktop):
  `apps/gateway/e2e/journey.sh` (new store → posts → item → buyer pays → ship → released), `onboard.mjs`,
  `buy-item.mjs`, plus the earlier `buy-deck.mjs` / `create-shop.mjs`.
- `apps/gateway/e2e/walkthrough.mjs` records the demo walkthrough (desktop app + phone onboarding + buyer) into one
  mp4 (`docs/demo-script.md` is the narrated 90-second version).

## How it is built

```
contracts/      Rust (near-sdk 5): nusd, handles, orders, billing, proof-log, escrow-policy + sandbox tests
spec/schemas/   JSON Schemas — the source of truth for envelopes, config, usage records
packages/
  contracts/    TS types + Ajv validators generated from spec/schemas
  providers/    capability router: priority + privacy tiers + live catalogs + retries + circuit breaker + attestation
  near/         chain client, handle cache, payment rails (testnet-direct, NEAR Intents 1Click quotes)
  db/           Postgres (Drizzle): store, step checkpoints, envelopes, outbox, sealed secrets
  swarm/        agent environment loader, the content-store steps (profile, opportunities, posts, video script,
                caption check) and the earlier deck pipeline
  billing/      usage records, Merkle batches, proofs
apps/
  gateway/      Hono: landing, onboarding, seller app, storefront + escrow checkout, NEP-413 wallet sign-in, A2A
  worker/       graphile-worker: analyse → opportunities → posts → render → video → publish (+ proof), outbox
                (chain calls), billing; ffmpeg/libass for headline strips and shorts
envs/content-store/  the content team as data: roles + prompts (profiler, opportunity-analyst, idea-writer,
                     video-director, insight-writer, learner, localizer)
deploy/         local compose (gateway, worker, db, tunnel, image service, TTS), llm-node (second Spark)
docs/           architecture, M0 scope, ADRs, swarm and contract specs, progress log
```

Key choices (each has an ADR in `docs/adr/`):

- **Private by default.** Buyer briefs only go to `local` (the seller's own GPUs) or `tee` (NEAR AI Cloud) endpoints;
  the router refuses anything else. TEE calls carry the attestation report hash into the proof.
- **Agents never hold free money.** Seller agents sign with function-call keys scoped to `orders`, `proofs` and
  `escrow`; spending limits and allowlists for hiring other agents are enforced by the `escrow-policy` contract.
- **Unstable networks are normal.** Every step is checkpointed and idempotent; chain calls go through an outbox;
  the router falls back from local GPUs to NEAR AI Cloud.
- **Honest selling.** No invented offers: a prompt rule, the Levanto Sage caption check and a warning before a post
  goes live; opportunity estimates are labelled estimates; the landing page shows real counts, not mock numbers.
- **Text on media is ours.** Headlines, hooks, captions and end-cards are rendered by our code in the brand font
  and colour; image prompts forbid lettering and a vision check catches what slips through.

## Built before / during the hackathon

The repository started on 2026-10-31 (after the hackathon announcement on 2026-10-19); all code was written in the
window. See `git log` and `docs/PROGRESS.md`.

## Libraries

near-sdk, near-contract-standards, cargo-near, near-workspaces, near-api-js, Hono, Drizzle ORM, postgres.js,
graphile-worker, Ajv, json-schema-to-typescript, yaml, Vitest, esbuild, Playwright (e2e in Chrome + WebKit),
sharp, ffmpeg + libass, vLLM, ComfyUI / Comfy Cloud (Qwen-Image-Edit 2511, Qwen-Image 2512, Wan 2.2), Kokoro-82M,
faster-whisper, Montserrat (OFL), NEAR AI Cloud (Qwen3.6 TEE, Levanto Sage), Phala DCAP verifier, MyNearWallet
(NEP-413), NEAR Intents 1Click API (quotes), Marp CLI, SearXNG.

## License

MIT
