# Nearchant — architecture

> **Status (2026-10-31):** the full concept. For the hackathon build, `m0-scope.md` and `adr/` win wherever they
> differ from this file. Repo rules for agents are in `/CLAUDE.md`.

> **Nearchant** = NEAR + merchant. Concept-stage architecture.
> Domain: `nearchant.com` · NEAR account: `nearchant.near` (testnet: `nearchant.testnet`).
> An open-source (MIT) platform where your own AI agents help you sell your goods and services online —
> on your own website, in embeddable widgets and in messenger bots — with crypto payments through
> NEAR Intents, private TEE inference, and a fully free local mode.

This file is the architecture reference. If a change would break a rule here, stop and say so instead of working
around it. **We are in the concept phase:**
get the contracts, boundaries and standards right first; features come after.

---

## 1. The concept in one page

**For the user (a seller):** a basic app that helps them earn money. They describe what they sell,
and a team of agents researches the market, agrees on a strategy, produces the content, keeps the
listings live, talks to buyers and takes payments.

**For the platform:** revenue comes from **metered inference and the hosted TEE gateway**, paid in
crypto, pay-as-you-go. People who run their own infrastructure use the same software for free.

| Layer | Option A: hosted (paid, crypto) | Option B: full local (free) |
|---|---|---|
| **Gateway** (API, agents, tools, storefront, bots) | Phala Cloud TEE gateway, run by us | `docker compose up` on your machine (e.g. DGX Spark) |
| **Models** | NEAR AI Cloud TEE models | Your own servers: vLLM, llama.cpp, Ollama, ComfyUI, whisper |
| **Media** (images, edits, video) | NEAR AI FLUX.2 or a hosted ComfyUI | Your own ComfyUI |
| **Public reach** (storefront, webhooks) | Gateway's public HTTPS domain | Tunnel: Cloudflare Tunnel, Tailscale Funnel, or your own domain |
| **Payments** | NEAR Intents (any chain) | NEAR Intents (any chain) |

Any mix is allowed. For example, you can run a local gateway with NEAR AI models, or the hosted gateway with your own ComfyUI.
Profiles differ only by config, never by code paths.

### Names and accounts

| What | Mainnet | Testnet / dev |
|---|---|---|
| Brand | **Nearchant** | — |
| Web domain | `nearchant.com` | `*.localhost` or a tunnel URL |
| Root NEAR account (hosts the `handles` factory, §13) | `nearchant.near` | `nearchant.testnet` |
| Seller handle | `alice.nearchant.near` ↔ `alice.nearchant.com` | `alice.nearchant.testnet` |
| Platform contracts (subaccounts) | `escrow.`, `proofs.`, `billing.`, `orders.`, `agents.`, `envs.`, `treasury.nearchant.near` | same under `nearchant.testnet` |
| Platform web origins | `app.` (dashboard), `api.` (gateway), `embed.` (widget script), `docs.` | — |
| Embed tags | `<nearchant-shop>`, `<nearchant-chat>` | — |
| npm scope / CLI | `@nearchant/*`, `nearchant` | — |

- The platform subaccount labels above are **reserved handles**; the `handles` contract refuses them.
- Account ids live in config (`config/defaults/accounts.yaml`), never in code, so forks and local deployments can use their own root account.

---

## 2. What users get

### Agent team
- **Research swarm.** Scouts search competitors, prices, reviews, channels and keywords in parallel. An analyst merges what they find into a cited dossier.
- **Debate council.** Advocate, skeptic, buyer persona, pricing analyst and judge argue over the dossier. The output is a strategy plus a minority report with the strongest objection.
- **Execution agents** produce listings, posts, ads, offers, images, **short videos** and translations. A **reviewer** checks every output against the brief and the sources.
- **Sales agents** keep listings live, answer buyer questions, quote prices and close orders.
- **Guardian** checks every payment and every outbound action against the user's policy. It can only block, never pay.

### Selling surfaces (where buyers meet the agents)
- **Handle + card:** every seller gets a handle that is both a NEAR account and a web address: `alice.nearchant.near` ↔ `https://alice.nearchant.com`. The address opens the seller's card and storefront (§13).
- **Storefront:** a hosted page per seller listing their goods and services, with checkout.
- **Embeds:** a `<script>` web component (with an iframe fallback) that lets a seller drop products, a service menu, a checkout button or a buyer-chat bubble into **any website**: their own site, a Webflow or WordPress page, a link-in-bio page.
- **Own website:** a headless API and SDK so a seller's existing site can show items and take payments directly.
- **Messenger bots:** Telegram first, then others. The buyer-chat agent answers in the chat, sends a product card, and takes payment in the same conversation.
- **Checkout:** NEAR Intents. The buyer pays from any chain and any asset. The seller receives the asset they chose (default USDC) in their own NEAR account. No banks, no cards, no custodial balances held by us.

---

## 3. Principles

1. **MIT license for everything:** code, specs, reference environments, contracts. No closed core, no license keys, no telemetry by default.
2. **Local is first-class.** Every feature works with `profile: local`. A feature that can't must be marked `cloud_only` with a reason.
3. **Standards over integrations.** All model I/O goes through the capability contracts in §6. Provider SDKs live only in `packages/providers/adapters/`.
4. **NEAR-native stack.** Identity, payments, contracts, agent registration and TEE agents use NEAR's own standards and tools (§14) before anything else. A non-NEAR tool is used only where NEAR has no equivalent, and the reason is recorded in an ADR.
5. **No hard-coded models, URLs, prices or accounts.** Config plus runtime discovery.
6. **Private by default.** Seller and buyer data go only to endpoints in the `tee` or `local` privacy tier. The router enforces this.
7. **Agents never hold free money.** They get function-call keys scoped to the escrow payment method only. Caps, allowlists and approval thresholds are checked by the contracts.
8. **Honest selling.** No fake reviews, invented testimonials, impersonation or spam. Every claim must trace to the dossier or the seller. Public posts need the seller's approval, per post or through a standing rule the seller explicitly set.
9. **Real commerce only.** Payments are for real goods, services and compute. No lending, interest, yield or speculative tokens. Stakes are refundable deposits. *(This is a product rule. We don't market it as a headline feature.)*
10. **Unstable networks are normal.** Every external call is retried, idempotent and resumable. If a provider dies, the swarm degrades; it never dies with it.
11. **Community reusable.** Anyone can publish an Agent Environment (§11) that others can run unchanged.

---

## 4. Monetization

**The model:** we sell metered inference and use of the hosted TEE gateway. There are no subscriptions, no banking and no cards.

- **Prepaid balance in crypto.** The user tops up a fixed amount, for example 10, 25 or 100 USDC, through NEAR Intents from any chain. The top-up goes into the `billing` contract under their account. Their usage is deducted from this balance.
- **Pay as you go.** Every call is metered (tokens, images, video seconds, audio seconds, tool-host minutes). The price is the provider's cost plus a transparent gateway margin. A **monthly statement** shows what was spent, but nothing auto-renews or auto-charges.
- **Spend limits.** The user sets per-day and per-month caps. When the balance or cap is hit, hosted calls stop cleanly and local endpoints keep working.
- **Free tier = your own infra.** Local endpoints cost 0 and are never metered. A user can mix: local LLM for free, plus NEAR AI images paid per image.
- **Commerce fee (optional, later).** A small fee on storefront and Intents sales processed through the hosted gateway. It never applies to fully local deployments.
- **Agent economy fee.** 5% of agent task payouts from the escrow, as in the original design.

**Billing architecture**
- The gateway writes a usage record per call. These records are batched and settled against the user's on-chain balance periodically, with a Merkle root of the records posted to the `billing` contract, so the user can verify each charge.
- Usage records are signed by the gateway's TEE key (Phala attestation). The user can prove what the gateway actually ran.
- `free-local` builds have billing compiled out, not just hidden; the `operator` profile has it on (ADR 0005).

---

## 5. System architecture

```mermaid
flowchart TB
  subgraph Surfaces["Selling surfaces"]
    SF["Storefront page"]
    EM["Embeds: web component / iframe"]
    WS["Seller's own website via SDK"]
    BOT["Messenger bots: Telegram first"]
    DASH["Seller dashboard + CLI"]
  end

  subgraph GW["Gateway: local Docker OR Phala Cloud TEE"]
    API["Control plane API"]
    SW["Swarm engine"]
    RT["Capability router"]
    TH["MCP tool host"]
    BILL["Metering + billing"]
  end

  subgraph Models["Model endpoints"]
    NEAR["NEAR AI Cloud TEE"]
    LOC["Local LLM / ASR / embeddings"]
    COMFY["ComfyUI: image, edit, video"]
  end

  subgraph Chain["NEAR"]
    INT["NEAR Intents"]
    C["Contracts: escrow-policy, proof-log, billing, orders, registries"]
  end

  Surfaces --> API
  API --> SW
  SW --> RT
  SW --> TH
  RT --> NEAR
  RT --> LOC
  RT --> COMFY
  API --> BILL
  BILL --> C
  API --> INT
  INT --> C
```

**Payment flow for a buyer**

```mermaid
sequenceDiagram
  participant B as Buyer
  participant S as Storefront / Bot / Embed
  participant G as Gateway
  participant I as NEAR Intents
  participant O as orders contract
  participant Sel as Seller account
  B->>S: Choose item, pay
  S->>G: Create order
  G->>I: Request quote (buyer's chain + asset to seller's asset)
  I-->>B: Deposit address / signed intent
  B->>I: Pay from any chain
  I->>O: Settle to orders contract
  O->>Sel: Release to seller (or hold until delivery for services)
  G-->>S: Order paid, confirmation to buyer
```

Data stores, all self-hostable and all included in the compose file:
- **Postgres** for state, the task queue and the outbox
- **pgvector** for embeddings
- **S3-compatible object storage** for media and dossiers (Garage or SeaweedFS locally, Cloudflare R2 hosted; see §15)
- optional **NATS** for multi-node fan-out

---

## 6. Capability contracts (the standard)

The wire format is the **OpenAI-compatible HTTP API** wherever one exists. NEAR AI Cloud, vLLM, llama.cpp, Ollama and TEI all speak it.
ComfyUI doesn't, so it gets a native adapter (§7).

| Capability | Standard endpoint | NEAR AI TEE default | Local / ComfyUI |
|---|---|---|---|
| `chat` | `POST /v1/chat/completions` (tools, streaming) | picked from `/v1/models` (TEE + tool support) | vLLM, llama.cpp, Ollama |
| `vision` | chat with `image_url` parts | model with `image` in `input_modalities` | vLLM VL models |
| `embed` | `POST /v1/embeddings` | `Qwen/Qwen3-Embedding-0.6B` | TEI, vLLM |
| `rerank` | `POST /v1/rerank` | `Qwen/Qwen3-Reranker-0.6B` | TEI |
| `image.generate` | `POST /v1/images/generations` → `b64_json` | `black-forest-labs/FLUX.2-klein-4B` | **ComfyUI** workflows |
| `image.edit` | `POST /v1/images/edits` | same | **ComfyUI** workflows |
| `video.generate` | internal contract (below) | none yet; route to ComfyUI | **ComfyUI** video workflows |
| `asr` | `POST /v1/audio/transcriptions` | `openai/whisper-large-v3` | faster-whisper, whisper.cpp |
| `attest` | `GET /v1/attestation/report?model=&nonce=` | NEAR AI report | dstack quote or none |

Model ids are defaults in `config/defaults/models.yaml`. They are checked against the live catalog at startup. If one is missing, the router picks the next candidate with the same capability and privacy tier and logs a warning; it never crashes.

**Video contract** (`video.generate`, internal because there's no OpenAI standard yet):

```json
{
  "prompt": "string",
  "negative_prompt": "string",
  "init_image": "s3://… | data:…",
  "duration_s": 6,
  "fps": 24,
  "aspect": "9:16",
  "resolution": "720p",
  "seed": 42,
  "workflow": "shorts/product-turntable@1"
}
```

It returns `{ "video_url", "poster_url", "duration_s", "model", "workflow_hash" }`.

**Normalized result envelope** (`packages/contracts`, generated from `spec/schemas/`). Every capability returns:
- `capability`, `output`, `model`, `endpointId`
- `privacyTier: tee | local | public`
- `usage` (tokens / images / video seconds / audio seconds)
- `costUsd` (0 for local)
- `attestation?` (when tier is `tee`)
- `requestHash`, `outputHash`, `latencyMs`

Billing, the reviewer and the proof log consume only this envelope.

**Embedding rule.** Vectors from different embedding models are not comparable. Every row stores `embedding_model` and `dim`. Queries stay within one model. Switching models means a background re-index.

---

## 7. ComfyUI integration (image, edit, video)

NEAR AI's FLUX.2-klein-4B is fast, cheap and private, and it's the default for quick visuals.
For high-quality product shots, image edits (background swap, inpaint, upscale) and **short-form video**, we call ComfyUI.

**Adapter:** `packages/providers/adapters/comfyui`
- `POST /upload/image` uploads input images (product photos, masks).
- `POST /prompt` submits `{ prompt: <workflow API JSON>, client_id }` and gets back a `prompt_id`.
- `WS /ws?clientId=…` streams progress (`executing`, `progress`, `executed`). If the socket drops, fall back to polling `GET /history/{prompt_id}`.
- `GET /view?filename=…&subfolder=…&type=output` fetches the outputs, which are then stored in object storage.
- `GET /object_info` and `GET /system_stats` provide startup validation: which nodes and models exist, and the free VRAM.

**Workflow templates** live in `workflows/` as ComfyUI *API-format* JSON plus a manifest:

```yaml
# workflows/shorts/product-turntable/manifest.yaml
id: shorts/product-turntable
version: 1
capability: video.generate
inputs:                  # maps contract fields to node inputs
  prompt:     { node: "6",  field: "text" }
  init_image: { node: "12", field: "image" }
  seed:       { node: "3",  field: "seed" }
  duration_s: { node: "40", field: "length", transform: "seconds_to_frames" }
requires:
  nodes:  [VHS_VideoCombine]
  models: ["wan2.2_i2v_*.safetensors"]   # glob; validated against /object_info
outputs:  { video: { node: "50" } }
```

- Workflows are **versioned and hashed**. `workflow_hash` goes into the result envelope and the proof log.
- Ship reference workflows for:
  - product photo cleanup and background swap
  - lifestyle scene generation
  - upscaling
  - image-to-video product turntable
  - text-to-video teaser
  - 9:16 shorts with captions, through a composition step (ffmpeg) that adds subtitles from the copywriter and an optional voiceover
- Video model choice (Wan, LTX-Video, Hunyuan, and so on) is a workflow concern, never code.
- ComfyUI runs locally (Spark, RTX 3090) or as a hosted endpoint. Both go through the same adapter.
- Long jobs run as async tasks in the swarm (§8) with progress events. They never block a request.

**Shorts pipeline (execution group):** strategy → copywriter writes the hook and script → image designer creates key frames → video agent runs the ComfyUI workflow → composer adds captions and audio → reviewer checks. Output is a 9:16 MP4 plus a poster, ready for the seller to post.

---

## 8. Swarm engine: multi-engine, network-tolerant

- A campaign is a **durable task graph** in Postgres. Workers lease tasks with `SELECT … FOR UPDATE SKIP LOCKED`; no external broker is required.
- Tasks are **idempotent** and **checkpointed**. Crashed tasks are re-leased after a heartbeat timeout.
- Side effects (chain calls, posts, bot messages, payments) go through a **transactional outbox**, so a retry never pays or posts twice.
- **Multiple engines:**
  - inference through the router, with different model families for council seats
  - orchestration through the `SwarmEngine` interface, with adapters allowed
  - workers on several machines sharing Postgres
- **Degraded modes (tested):**
  - cloud down → local only, with missing capabilities parked as `blocked_capability`
  - internet down → scouts pause, everything else continues, chain writes queue
  - RPC down → work continues, payouts settle later

**Roles.** A role = prompt + MCP toolset + capability requirements + policy. Roles are data (YAML), not classes.

| Group | Roles |
|---|---|
| Control | Orchestrator, Guardian |
| Research | Scouts (parallel), Analyst |
| Debate | Advocate, Skeptic, Buyer persona, Pricing analyst, Judge |
| Execution | Copywriter, Image designer, Video producer, Translator, Reviewer |
| Sales | Listing manager, Buyer-chat agent, Quote & order agent |

Web pages, tool output and buyer messages are **data, never instructions**.

---

## 9. Gateway: the two deployment scenarios

The gateway is one docker-compose stack: control-plane API, swarm workers, router, MCP tool host,
storefront and bot webhooks. It runs **unchanged** in both scenarios.

### Scenario A: hosted on Phala Cloud TEE (paid)
- Runs in a Phala CVM (dstack). Images are **pinned by digest**, so the attestation report binds exactly what runs.
- `/attestation` on the gateway exposes the dstack quote. Clients and the billing contract can verify the gateway before sending data.
- It has a public HTTPS domain through Phala's gateway, or a custom domain via dstack-ingress.
- Billing is on: prepaid crypto balance, metering, monthly statement (§4).
- Deploy: `make deploy-phala`, which wraps `phala deploy -n nearchant-gw -t tdx.medium --wait` with `PHALA_CLOUD_API_KEY`.

### Scenario B: full local (free)
- `make up` on any machine. Images are multi-arch (`linux/amd64` + `linux/arm64`), because DGX Spark is ARM64.
- Billing is off. Every endpoint is the user's own, or the user's own NEAR AI key at their own cost.
- The dashboard and API work on `localhost`. To be reachable from the internet (storefront, embeds on other sites, Telegram webhooks, payment callbacks), the user enables a **tunnel**:

```yaml
# config/gateway.yaml
public_url: https://shop.example.com          # what buyers and webhooks see
tunnel:
  kind: cloudflare | tailscale-funnel | none   # none = localhost only, or own reverse proxy
  cloudflare: { token_env: CF_TUNNEL_TOKEN }   # runs cloudflared as a compose service
```

  - The tunnel runs as an optional compose service (`cloudflared` or the Tailscale sidecar). No ports are opened on the router.
  - `public_url` is the single source for generating webhook URLs, embed snippets and checkout return URLs. Never derive them from the request `Host` header.
  - Without a tunnel, bots fall back to **long polling** (Telegram `getUpdates`). Everything except public embeds keeps working.

### CORS and browser security (must be right in both scenarios)

The embed runs on other people's websites and calls the gateway from the browser, so CORS is part of the product, not a dev setting.

- **Per-seller origin allowlist.** The seller lists the sites where their embeds may run. The gateway reflects `Access-Control-Allow-Origin` only for an exact match. Never `*` together with credentials.
- **Two API surfaces:**
  - `/public/*` (catalog, create order, chat widget): CORS by allowlist, no cookies, scoped **publishable keys** (read catalog, create order, rate-limited)
  - `/admin/*` (dashboard): same-origin only, session auth, no CORS
- **Preflight:** answer `OPTIONS` with exact allowed methods and headers and a `Vary: Origin` header. Cache with `Access-Control-Max-Age`.
- **Localhost and Private Network Access:** when a public page calls a gateway on `localhost` or the LAN, Chromium sends a PNA preflight. Answer it with `Access-Control-Allow-Private-Network: true` only for allowlisted origins. In local mode the dashboard origin (`http://localhost:<port>`) is allowlisted by default. The tunnel origin is added automatically from `public_url`.
- **Webhooks are not CORS.** Verify each one by its own signature:
  - Telegram: the `X-Telegram-Bot-Api-Secret-Token` header
  - payment and Intents callbacks: signature checks
  - and in every case, confirm on-chain before marking an order paid
- **Embeds:** CSP-friendly. The web component is in a shadow DOM, with no inline `eval`. The iframe fallback sets a `frame-ancestors` CSP from the same seller allowlist.
- **Tunnel safety:** `/admin/*` is never exposed through the tunnel by default. It requires `expose_admin: true` and admin auth.
- Test matrix in CI: localhost dashboard, tunnel plus foreign-origin embed, Phala domain plus foreign-origin embed, a disallowed origin (must fail), and the PNA preflight.

---

## 10. Provider configuration: multiple URLs

```yaml
# config/providers.yaml
endpoints:
  - id: nearai
    base_url: https://cloud-api.near.ai/v1
    api_key_env: NEARAI_API_KEY
    privacy_tier: tee
    attestation: nearai
    capabilities: [chat, vision, embed, rerank, image.generate, image.edit, asr]
    discover_models: true

  - id: spark-llm
    base_url: http://spark-1.lan:8000/v1      # vLLM
    privacy_tier: local
    capabilities: [chat, vision]
    discover_models: true

  - id: spark-comfy
    base_url: http://spark-1.lan:8188         # native ComfyUI API, not /v1
    adapter: comfyui
    privacy_tier: local
    capabilities: [image.generate, image.edit, video.generate]
    workflows: [default/*, shorts/*]

  - id: spark-audio
    base_url: http://spark-2.lan:9000/v1      # faster-whisper adapter
    privacy_tier: local
    capabilities: [asr]

routing:
  default_strategy: priority_then_fallback    # lowest_cost | lowest_latency | round_robin
  chat:           [spark-llm, nearai]
  embed:          [nearai]                     # one embedding family
  image.generate: [spark-comfy, nearai]        # quality first, fast TEE fallback
  image.edit:     [spark-comfy, nearai]
  video.generate: [spark-comfy]
  asr:            [spark-audio, nearai]
  private_data_allowed_tiers: [tee, local]
```

**Router duties**
- validate every endpoint at startup (`/v1/models` or `/object_info`)
- health checks with a circuit breaker
- enforce privacy by `dataClass`
- verify TEE attestation before the first private call
- fall back within the allowed tiers
- compute `costUsd` for billing
- accept new adapters as folders implementing `CapabilityAdapter`

---

## 11. Agent Environment spec (community standard)

A portable, versioned bundle that says *what* an agent team needs, never *which vendor* serves it.

```
my-env/
  agentenv.yaml     # manifest, validated by spec/schemas/agentenv.schema.json
  roles/*.yaml      # prompt, tools, capabilities, policy
  prompts/*.md
  workflows/        # optional ComfyUI workflow templates
  tools/compose.yaml  # extra MCP servers (multi-arch, digest-pinned)
  evals/*.yaml
  README.md
```

```yaml
spec: nearchant.com/spec/agentenv/v1
name: handmade-goods-seller
version: 0.3.0
license: MIT
requires:
  capabilities:
    chat:  { tool_calling: true, min_context: 32000 }
    embed: {}
    image.generate: {}
    video.generate: { optional: true }
  data_class: private
roles: [orchestrator, guardian, scout, analyst, advocate, skeptic, judge, copywriter, image-designer, video-producer, reviewer, buyer-chat]
tools: [web-fetch, web-search, vector-store, near-tools, telegram]
policy: { publish: require_approval, payments: escrow_only }
```

- Use the CLI to work with environments: `nearchant env validate | run | pack | publish`.
- The `env-registry` contract stores the name, version, author and content hash. Runners refuse a hash mismatch.
- At `run`, the runner checks `requires` against the user's endpoints and names exactly what's missing.

---

## 12. NEAR layer

Contracts live in `contracts/` (Rust, `near-sdk`) with unit and sandbox tests.

| Contract | Purpose |
|---|---|
| `escrow-policy` | Campaign budgets via Intents; caps, allowlist, approval threshold, release, refund, 5% agent-economy fee |
| `proof-log` | Per task: hashes of brief, model or workflow, output, and attestation ref. Payouts require an entry plus a passed review |
| `billing` | Prepaid user balances (Intents top-ups), spend caps, settlement of usage batches by Merkle root, refunds of unused balance |
| `orders` | Buyer payments for seller items and services; immediate release for goods, or held until delivery confirmation for services |
| `agent-registry` | Agents with refundable stake and reputation |
| `env-registry` | Agent Environment versions and hashes |

| `handles` | Handle factory at `nearchant.near`: claims, creates subaccounts, stores each handle's card, gateway URL and allowed embed origins (§13) |

- Agents use function-call keys only. All amounts are `U128` strings, never floats.
- TEE signature verification happens either in the contract or through a verifier service. The interface `verify(proof_id) -> bool` stays stable either way.

---

## 13. Handles, subdomains and the seller card

**The idea:** one name works on-chain and on the web.
`alice.nearchant.near` is Alice's NEAR account. `https://alice.nearchant.com` is her card and storefront.
Buyers can find her by either name, and payments go to the account behind the name.

### How the two names are linked

NEAR accounts and DNS are separate systems, so we link them through the `handles` contract and a small edge router.

- **On-chain side.** Only the parent account can create subaccounts, so `nearchant.near` hosts the `handles` factory contract.
  - `claim(handle, public_key)` creates `alice.nearchant.near`, funds its storage, and adds **the seller's own key** as a full-access key. The seller owns the account; we keep no key to it.
  - Sellers who already have an account (`alice.near`, an implicit account, a wallet from another chain via Intents) can **link** a handle instead of creating a subaccount. The registry then maps `alice → alice.near`.
  - Each handle record holds: owner account, payout account and asset, card data (name, avatar, bio, links, content hash of media), `gateway_url`, and the allowed embed origins.
- **Web side.** A wildcard DNS record `*.nearchant.com` points to the edge router.
  - The router reads the host, takes the first label (`alice`), looks up the handle in a cache that is refreshed from contract events, and serves the card.
  - Universal SSL covers one level of wildcard (`*.nearchant.com`), so handles are **one label only**. No `shop.alice.nearchant.com`; use paths instead (`alice.nearchant.com/p/<item>`).
  - Missing or suspended handles return a 404 card, never another seller's page.

```mermaid
flowchart LR
  B["Buyer opens alice.nearchant.com"] --> E["Edge router"]
  E --> K["Handle cache"]
  K -. "refreshed from events" .- H["handles contract at nearchant.near"]
  E -->|"hosted seller"| G1["Hosted gateway on Phala"]
  E -->|"self-hosted seller"| G2["Seller's own gateway via tunnel"]
  E -->|"static card"| C["Card page from cache"]
```

### Who serves the card

- **Hosted sellers:** the edge router forwards to the hosted gateway on Phala, which renders the card, storefront and checkout.
- **Self-hosted sellers (free):** the seller sets `gateway_url` in their handle record to their tunnel URL. The edge router proxies `alice.nearchant.com` to it, with rate limits. A seller running on a DGX Spark at home still gets a clean public address.
- **Offline fallback:** if the seller's gateway is unreachable, the router serves the last cached card with a "shop temporarily offline" banner. Checkout is disabled until the gateway is back.
- **Decentralized fallback (optional):** the same card can be served from the chain through Web4, at `alice.nearchant.near.page`, so the card survives even if our edge goes away.

### Custom domains

- A seller can point their own domain (`shop.alice-ceramics.com`) at their card.
- Hosted: Cloudflare for SaaS custom hostnames. The first 100 are free, then about $0.10 per hostname per month.
- Self-hosted: Caddy with on-demand TLS does the same job without Cloudflare.
- The custom domain is stored in the handle record and verified by a DNS TXT record before it goes live.

### The embed widget for a handle

One script serves every seller; the handle picks the data.

```html
<script type="module" src="https://embed.nearchant.com/v1/embed.js"></script>
<nearchant-shop handle="alice" view="products"></nearchant-shop>
<nearchant-chat handle="alice"></nearchant-chat>
```

- The script comes from one versioned, cacheable URL (`/v1/` is a frozen API). It never changes per seller.
- Data calls go to `https://alice.nearchant.com/public/*`. CORS is checked against the **allowed embed origins in Alice's handle record** (§9). The record is the single source of truth for both hosted and self-hosted sellers.
- The iframe fallback is `https://alice.nearchant.com/embed/<view>`, with a `frame-ancestors` CSP built from the same origin list.
- Self-hosted sellers can also serve the script from their own gateway (`/embed.js`), so a fully local deployment needs nothing from us.

### Safety rules for handles

- **Name rules:** lowercase `a-z`, `0-9`, `-`, `_`; 2–32 characters; must also be a valid NEAR subaccount label. No dots.
- **Reserved names:** `www`, `app`, `api`, `admin`, `embed`, `cdn`, `docs`, `status`, `mail`, `auth`, `pay`, `checkout`, `support`, `help`, the platform contract labels (`escrow`, `proofs`, `billing`, `orders`, `agents`, `envs`, `treasury`), plus known brand names. The list lives in the contract and can be extended.
- **Impersonation:** handles that copy a well-known brand can be challenged and suspended. This follows the honest-selling principle.
- **Cookie isolation:** seller pages live on subdomains of a domain that holds **no** dashboard cookies.
  - The dashboard runs on a separate origin (`app.nearchant.com` with host-only cookies, or a separate domain).
  - Never set cookies on `.nearchant.com`.
  - Register the seller domain on the Public Suffix List, so one seller's page can't read or plant cookies for another.
- **Squatting:** a refundable deposit per handle, and claims expire if the account never publishes a card.

---

## 14. NEAR-native stack

Rule: use NEAR's own standard first. These are the defaults Claude Code must use.

| Need | NEAR-native choice |
|---|---|
| Smart contracts | Rust + `near-sdk`, built with `cargo-near` (reproducible builds) |
| Contract tests | `near-workspaces` sandbox |
| Many identical contracts (per-seller or per-agent) | NEAR global contracts, deployed once and reused |
| Identity and handles | Named accounts and subaccounts (§13) |
| Agent permissions | Function-call access keys scoped to one method |
| Sign-in | NEP-413 signed messages ("sign in with NEAR"), verified by the gateway |
| Tokens | NEP-141 fungible tokens (USDC and others) with NEP-145 storage management |
| On-chain events | NEP-297 event logs; the indexer and edge cache listen to these |
| Payments from any chain | NEAR Intents through the 1Click API (`1click.chaindefuser.com`): tokens → dry quote → real quote with deposit address → deposit → status. Confidential Intents where the buyer wants privacy |
| TEE agents | ~~Shade Agent Framework~~ (deprecated, ADR 0002): NEAR AI Cloud attestation + the gateway's Phala/dstack quote |
| Keys across chains | Chain Signatures (used by Shade Agents for key management) |
| Inference | NEAR AI Cloud TEE models |
| Wallet connection in the browser | NEAR Wallet Selector (`@near-wallet-selector/core`, modal UI, React hook) |
| JS client | `near-api-js` (or the modular `@near-js/*` packages) |
| CLI | `near-cli-rs` |
| On-chain web hosting (optional) | Web4 (`*.near.page`), with content on IPFS or NEARFS |

**Note:** the Shade Agent Framework is deprecated (ADR 0002).

---

## 15. Tooling: cost-effective, fast, manageable

Where NEAR has no equivalent, these are the defaults. Every choice keeps a free self-hosted option, so the MIT, local-first promise holds.

| Area | Default | Why | Self-hosted / alternative |
|---|---|---|---|
| Monorepo | pnpm + Turborepo | Fast installs and cached builds | — |
| HTTP API | **Hono** (TypeScript) | Same code runs on Node, Bun and Cloudflare Workers, so the gateway and the edge share one codebase | — |
| Validation | JSON Schema as source of truth, Zod at runtime | One spec for TS types and for community envs | — |
| Database | Postgres 16 + pgvector + Drizzle ORM | One database for state, vectors and queue | — |
| Task queue | graphile-worker (or pg-boss) | Postgres-only, uses `SKIP LOCKED`, no Redis needed | — |
| Object storage | Cloudflare R2 (hosted) | No egress fees for media and videos | Garage or SeaweedFS (S3-compatible, light) |
| Edge router, handles, embed CDN | Cloudflare Workers + KV + wildcard DNS | Free or cheap at our scale; global; runs the same Hono code | Caddy with on-demand TLS |
| Custom seller domains | Cloudflare for SaaS | 100 hostnames free, then about $0.10 each per month | Caddy on-demand TLS |
| Tunnels for local sellers | `cloudflared`, Tailscale Funnel | Free, no open ports | frp, own reverse proxy |
| Dashboard | Vite + React | Fast builds, simple | — |
| Storefront and card pages | Hono JSX, server-rendered at the edge | Fast first paint, good for search engines | Same code on the local gateway |
| Embed widget | Lit web components, built as a small ES module | Tiny, works in any site, shadow DOM | — |
| Telegram bot | grammY | TypeScript, runs on Workers and Node, supports webhooks and long polling | — |
| MCP | Official `@modelcontextprotocol/sdk` (TypeScript) | Standard | — |
| Model client | OpenAI-compatible client with configurable `base_url` | Works with NEAR AI and every local server | — |
| Video composition | ffmpeg | Free, fast | — |
| Tests | Vitest, Playwright (embed + CORS matrix), near-workspaces | — | — |
| Observability | OpenTelemetry, optional Grafana stack | Vendor-neutral | — |

**Cost notes for the hosted platform** (check current prices before committing):
- Edge, DNS, wildcard TLS and the embed CDN fit within Cloudflare's free or lowest paid tier at launch scale.
- Phala CVM size is the main fixed cost; start with one gateway CVM and scale by adding workers.
- NEAR costs are small: storage deposits for handle accounts and gas for settlement batches. Decide whether the platform sponsors the handle deposit or the seller pays it from their first top-up.

---

## 16. Repo layout

```
apps/
  gateway/      control-plane API, public + admin surfaces, CORS, webhooks
  worker/       swarm worker
  toolhost/     MCP servers + gateway, attestation
  dashboard/    seller UI
  storefront/   hosted shop and card pages
  edge/         handle router: wildcard subdomains, custom domains, embed CDN (Hono on Workers or Node)
  embed/        web component + iframe build
  bots/         telegram (first), others later
  cli/          nearchant CLI
packages/
  contracts/    TS types generated from spec/schemas
  providers/    router + adapters (openai-compatible, comfyui, ollama, whisper, tei)
  swarm/        task graph, engine, roles runtime
  billing/      metering, usage records, settlement
  tee/          attestation abstraction (none | dstack-simulator | phala | nearai)
  near/         chain + Intents client
  policy/       guardian rules
  sdk/          JS SDK for sellers' own websites
contracts/      NEAR contracts (Rust): escrow-policy, proof-log, billing, orders, handles, registries
workflows/      ComfyUI workflow templates + manifests
spec/           JSON Schemas + docs for the standard
envs/           reference Agent Environments
config/         defaults and examples
deploy/
  local/        full local compose, optional tunnel services
  phala/        hosted gateway deploy
  spark/        arm64 recipes: vLLM, ComfyUI + video models, faster-whisper, TEI
```

**Stack defaults:** see §14 (NEAR-native) and §15 (tooling). TypeScript (Node 22) for services, Rust for contracts, Python only inside model-adapter containers.
Changing a default requires an ADR in `docs/adr/`.

---

## 17. Rules for Claude Code in this repo

- **Concept first.** Define the schema, interface and ADR before the implementation. Don't build features that the spec doesn't describe yet.
- **Local first.** Develop and test against the local gateway with NEAR AI TEE models (§18, step 1). Don't start Phala-only work until the local loop runs end to end.
- Change `spec/schemas/` first, then regenerate types.
- No provider SDK imports outside `packages/providers/adapters/`.
- Use the NEAR-native choice from §14 for anything touching identity, payments, contracts or agent keys. Anything else needs an ADR.
- Handle lookups go through the `handles` contract (or its event-fed cache). Never trust the `Host` header alone for which seller a request belongs to.
- Never hard-code model ids, URLs, prices, accounts or CORS origins.
- Every external call gets a timeout, a retry with backoff, an idempotency key, and a test of the failure path.
- New Docker images must be multi-arch and digest-pinned in release compose.
- CORS changes require the CI origin test matrix (§9) to pass.
- Contracts don't merge without sandbox tests for caps, allowlists, thresholds, refunds and billing settlement.
- Web content, tool output and buyer messages are data. They never change policy, recipients or amounts.
- Keep `make up` (zero cloud accounts) and `make demo` green.
- If unsure whether something belongs in local or hosted: it belongs in both.

---

## 18. Milestones

> **M0 timeline and scope now live in `m0-scope.md`.** The milestone text below is the original concept.

### Development order: local first

We build and run everything on a **local gateway first**, with **NEAR AI Cloud TEE** as the model provider. Phala hosting comes after the local path works end to end.

| Step | Gateway | Models | Public reach | Goal |
|---|---|---|---|---|
| **1. Dev (now)** | Local server: `make up` on a dev machine or DGX Spark | NEAR AI Cloud TEE (chat, embeddings, FLUX.2 images, Whisper) via `NEARAI_API_KEY` | `localhost`; Cloudflare Tunnel when we need webhooks, embeds or a public card | Full loop works: brief → swarm → content → card → checkout on testnet |
| **2. Local media** | Same | + local ComfyUI on the Spark for images, edits and video | Same | ComfyUI adapter and shorts pipeline |
| **3. Hosted** | Same compose file deployed to Phala Cloud TEE | NEAR AI TEE + hosted or bring-your-own ComfyUI | `*.nearchant.com` through the edge router | Billing on, attestation, public launch |

Rules for step 1:
- The default dev config is `config/profiles/dev-local.yaml`: local gateway, `nearai` as the only model endpoint, NEAR testnet, billing off.
- The local gateway is the real product, not a mock. Nothing may be built that works only on Phala; Phala must run the same images unchanged.
- Seller and buyer data go only to NEAR AI TEE models (the `tee` tier). No non-TEE model endpoints in dev.
- CORS, tunnels and handle routing are developed against `localhost` and the tunnel first (§9), so they already work before hosting.
- Phala-specific code (dstack attestation, `make deploy-phala`) is kept behind the `tee.kind` switch and tested with `dstack-simulator` until step 3.

**M0: NEAR Hackathon (development 1–14 Nov 2026; all code written from 1 Nov).**
Built in steps 1–2: local gateway + NEAR AI TEE models on testnet. Deploying the same compose file to Phala for the demo is a stretch goal, attempted only after the local loop is complete. Scope:
- escrow-policy, proof-log and billing contracts on testnet
- Intents top-up from one non-NEAR chain
- router with the nearai and comfyui adapters
- research swarm, council, copywriter, image designer, reviewer, guardian
- `handles` contract on testnet: claim `alice.nearchant.testnet`, card served at `alice.nearchant.com` through the edge router
- a storefront page with one embed and Intents checkout
- a Telegram buyer-chat bot
- README, Mermaid diagrams, contract tests, a 90-second video

**M1: local first-class.** Spark recipes, `make doctor`, tunnel services, the CORS/PNA test matrix, degraded-mode tests.

**M2: selling + video.** Orders contract, shorts pipeline, more bots, the SDK for sellers' own websites.

**M3: community.** Freeze Agent Environment spec v1, ship the env registry, accept outside agents with stakes.

---

## 19. Open questions (decide, then record an ADR)

1. TEE signature verification: in-contract or a verifier service.
2. Usage settlement cadence and batch size for `billing`.
3. Hosted ComfyUI: run our own GPU nodes, or only support bring-your-own.
4. Which messengers come after Telegram.
5. Whether local endpoints can present a dstack quote and count as the `tee` tier.
6. Whether seller pages and the dashboard share `nearchant.com` (dashboard at `app.nearchant.com`) or the dashboard moves to a separate domain for stronger cookie isolation.
7. Who pays the storage deposit for a new handle account. Testnet: the platform (ADR 0001); mainnet still open.
8. ~~Whether to adopt the Shade Agent Framework~~ — closed: dropped (ADR 0002).