# M0 scope — NEAR hackathon (1–14 Nov 2026)

Agreed with the owner on 2026-10-31. This file wins over `architecture.md` wherever they differ.
Each decision has an ADR in `docs/adr/`.

## Goal

Win the hackathon **and** ship an MVP people can really use. Solo, part-time.

- Code counts from the announcement on **2026-10-19** (FAQ Q-001); only NEAR integration built in the window is
  judged. Hackathon officially opens 2026-11-01 00:00 UTC.
- **Feature freeze 12 Nov.** 13–14 Nov: owner testing, README, video, X post, submission.
- Deadline **14 Nov 23:59 UTC**. Judging 16–18 Nov: Claude Code / Codex run the repo against the README first,
  then humans. Tracks: **Agent Economy** (lead), Privacy & Private AI, Autonomous Business.

## The one demo story

Alice sells **"Pitch deck in 1 hour — 5 nUSD"** at `alice.nearchant.com`.

1. A buyer pays → the `orders` contract **holds** the money. *(flow 1: buyer → seller)*
2. Alice's agents research, debate and build the deck. Every model call is metered against Alice's `billing`
   balance. *(flow 2: seller → platform)*
3. One subtask is hired from another agent over **A2A + x402**, paid from the campaign budget.
   *(flow 3: agent → agent)*
4. Reviewer passes → `proof-log` entry → buyer previews and clicks **Accept** (or auto-release after the
   timeout) → `orders` **releases** to Alice.

Every feature is judged by whether it serves this story.

## Money and chain

- **Testnet only** for M0, with **`nUSD`**: our own NEP-141 test token, labelled TEST in every UI, with a faucet
  (100 nUSD / account / day). Nobody pays real money — not the owner, not judges. Mainnet USDC later = config only.
- **Sponsored accounts**: one click creates `<name>.nearchant.testnet` for buyers and sellers; no wallet install.
  The platform pays the storage deposit on testnet.
- `PaymentRail` interface: `testnet-direct` (ft_transfer_call to `orders`) now; `intents-1click` for mainnet.
  Checkout shows a **live mainnet 1Click dry quote** (free) so the any-chain experience is visible.
- Contracts (Rust, `near-sdk`, `cargo-near`, sandbox-tested):

  | Contract | Account | M0 job |
  |---|---|---|
  | `nusd` | `nusd.nearchant.testnet` | test token + faucet |
  | `handles` | `nearchant.testnet` (factory) | claim / link handle, card data, gateway URL, embed origins |
  | `orders` | `orders.nearchant.testnet` | hold buyer payment, release on accept/timeout, refund on seller approval |
  | `billing` | `billing.nearchant.testnet` | prepaid balances, spend caps, settle usage batches by Merkle root |
  | `proof-log` | `proofs.nearchant.testnet` | per-task hashes (brief, model/workflow, output, attestation ref) |
  | `escrow-policy` | `escrow.nearchant.testnet` | campaign policy (allowlist, threshold), refund of unused budget |

- **Flow 3 budgets**: each campaign gets a budget subaccount funded with exactly its budget (balance = hard cap).
  The agent's key there is function-call only (`ft_transfer` on nUSD). The Guardian checks every payment before
  signing. 5% Nearchant fee only on hires between Nearchant agents; market hires pay the market's fee only.
- Keys: root key in the **macOS Keychain** (near-cli-rs), never in the repo. The gateway uses
  `relayer.nearchant.testnet` with **function-call keys only**.

## Infrastructure

- Models are reached through the router with fallback **Spark → other Spark → NEAR AI Cloud (TEE)**.
  The owner's existing `inference_system` cluster (LiteLLM on every node) is used as the local OpenAI-compatible
  endpoint; Nearchant doesn't run its own vLLM. Two model families for the council (different seats, real debate).
- Gateway primary + Postgres primary + `cloudflared` on a Spark. A **Phala CVM** on the tailnet is a hot standby
  (Postgres streaming replica + second `cloudflared` connector). `make failover` promotes by hand.
  Around 12 Nov Phala becomes the permanent primary for judging.
- `*.nearchant.com` → one Cloudflare Tunnel → the gateway, which maps the subdomain to a handle through the
  `handles` cache. No edge Worker in M0.
- Profiles: `operator` (billing on: cluster, then Phala), `free-local` (billing compiled out), `demo` (replay
  provider, short timeouts).

## Surfaces in M0

- Seller card + storefront at `<handle>.nearchant.com`; **"Create your shop in 60 s"** (handle, one paragraph,
  price).
- **Telegram: each seller brings their own bot token** (no platform bot). Tokens encrypted at rest with the
  gateway key, never on chain, never shown again. Per-bot webhook `/bots/telegram/<handle>` checked with that
  bot's secret token; long polling when there's no public URL.
- **NEAR AI Agent Market**: Alice's agent listed as a self-hosted agent (webhook `hire.created` → swarm →
  submit Markdown deliverable). Every seller agent serves an **A2A agent card** (`/.well-known/agent-card.json`).
- Deliverable: **Marp Markdown → PDF + PPTX + HTML preview**. Buyer: Accept / one revision / refund request
  (seller approves). Auto-release 48 h (5 min in `demo`).

## Guardian defaults (seller can edit)

- Public posts (market listing text, Telegram broadcasts): approval required.
- Buyer chat: allowed, but prices only from the catalog; no invented discounts.
- Spend: ≤ 2 nUSD per hire automatic; above needs approval (dashboard or Telegram button); ≤ 20 nUSD/day;
  allowlisted payees only.
- Refunds: always need approval.

## For judges

1. Live demo URL (must stay up 16–18 Nov).
2. `make demo`: Docker only; uses `NEARAI_API_KEY` if set, otherwise the **replay provider** (recorded model
   responses) — no accounts, no GPU.
3. `cargo test` sandbox tests.
4. A README that a fresh agent can follow step by step.

## Timeline

| Days | Deliverable |
|---|---|
| 1–2 Nov | Repo skeleton, schemas, contracts + sandbox tests, deployed to testnet |
| 3–5 Nov | Gateway + router (nearai, local cluster, replay) + minimal swarm + deck producer |
| 6–7 Nov | Card/storefront via tunnel, checkout, billing metering |
| 8 Nov | Phala deploy (same compose) + Agent Market listing + A2A card |
| 9–10 Nov | Flow 3 (budget subaccount, x402 to our second agent), Telegram bots |
| 11–12 Nov | Buffer → feature freeze |
| 13–14 Nov | Owner testing, README, `make demo`, video, X post, submit |

## Cut from M0

Embed widget, ComfyUI + video/shorts, mainnet, edge Worker, custom domains, seller SDK, Shade Agents.
If time slips, drop in this order: Telegram → flow 3 against the real market (keep it against our second agent).
