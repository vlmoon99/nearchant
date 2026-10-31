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

### Owner actions
- `gx10-8695`: `sudo usermod -aG docker server` (then log out/in) so it can run containers.
- Testnet NEAR: 10 NEAR may not cover six contract deployments; I'll top up with extra faucet accounts.
- Phala Cloud account with credit, needed by ~8 Nov.
- Cloudflare: a tunnel token for `*.nearchant.com` (or API token so I can create it), needed by ~6 Nov.
