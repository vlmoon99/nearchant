# 0001 — Develop and demo on testnet with the free `nUSD` test token

**Context.** NEAR Intents 1Click and the Agent Market's x402 payments exist on mainnet only (checked 2026-10-31).
The owner wants a demo that costs nothing for them or for judges.

**Decision.** All M0 development, testing and the judged demo run on NEAR testnet. Money is `nUSD`, a NEP-141
token we deploy at `nusd.nearchant.testnet` with a rate-limited faucet. It is labelled TEST in every UI. The same
token is used for checkout, billing top-ups and campaign budgets. Buyer and seller accounts are sponsored
subaccounts of `nearchant.testnet`; the platform pays their storage deposit on testnet.

**Consequences.** No real Intents settlement in the demo; checkout shows a live mainnet dry quote instead (0004).
Moving to mainnet USDC is a config change (token account, rail). Who pays the mainnet storage deposit stays open.
