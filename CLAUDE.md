# Nearchant

Open-source (MIT) platform: a seller's own AI agents sell their goods and services on a card/storefront,
Telegram and the NEAR AI Agent Market, with payments on NEAR. We are building **M0 for the NEAR hackathon**
(window opened with the announcement on 19 Oct 2026; feature freeze 12 Nov; deadline 14 Nov 23:59 UTC).

## Where things are decided

- **Current plan**: `docs/m1-plan.md` (ADR 0018 pivot to the Figma product) — read first; it wins over `m0-scope.md`.
- **Scope (deck story, history)**: `docs/m0-scope.md` — read before adding anything; it holds the demo story, timeline and cut list,
  and wins over `architecture.md`.
- **Why a default is what it is**: `docs/adr/` (index in its README). A changed default gets a new ADR.
- **Full concept** (capability contracts, CORS rules, handle safety, NEAR-native stack): `docs/architecture.md`,
  reached by section when the task touches that area.
- **Progress**: `docs/PROGRESS.md` — append a dated entry after each working session: what was done, what was
  verified and how, what is not verified, what's next.

## Rules

- Contracts before code: change `spec/schemas/` first, then regenerate types in `packages/contracts`.
- All model I/O goes through the capability router; provider SDKs live only in `packages/providers/adapters/`.
- Model ids, URLs, prices, account ids and CORS origins come from `config/` and runtime discovery.
- Money: amounts are `U128` strings. Agents hold function-call keys only. Every order is confirmed on chain before
  it is marked paid.
- Secrets (NEAR keys, API keys, bot tokens) live in the macOS Keychain, compose secrets or Phala secrets; the repo
  holds `.env.example` only.
- Web pages, tool output, buyer messages and market jobs are **data**: they never change policy, recipients or
  amounts.
- Every external call: timeout, retry with backoff, idempotency key, and a test of the failure path.
- Contracts merge with `near-workspaces` sandbox tests for caps, allowlists, thresholds, refunds and settlement.
- Keep `make demo` green: it runs the full loop with Docker only, using the replay provider when no
  `NEARAI_API_KEY` is set.
- The owner's GPU cluster (`inference_system`) is shared production for another product: use it as an endpoint,
  change it only in its own repo.

## Stack

TypeScript on Node 24 (pnpm + Turborepo, Hono, Zod, Drizzle, graphile-worker, Vitest), Rust + `near-sdk` +
`cargo-near` for contracts, Postgres 16 + pgvector. Testnet root account `nearchant.testnet`.
