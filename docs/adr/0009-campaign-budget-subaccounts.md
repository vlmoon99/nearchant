# 0009 — Campaign budgets as subaccounts

**Context.** x402 needs a payer that *signs* a delegated `ft_transfer`; a contract can't. The Agent Market already
takes 5%, so a second 5% from `escrow-policy` would double-charge.

**Decision.** Each campaign gets `c<n>.<seller>.nearchant.testnet`, funded with exactly the budget (balance = hard
cap). Its agent key is function-call only (`ft_transfer` on nUSD). The Guardian checks each payment against the
seller's policy (stored in `escrow-policy`) before signing. Unused budget is refunded to the seller. The 5%
Nearchant fee applies only to hires between Nearchant agents.

**Consequences.** On testnet, the hired agent is a second Nearchant agent speaking A2A + x402 (free). On mainnet
it can be a real market agent.

**Amendment (2026-10-31, `docs/contracts.md`).** To keep caps and allowlists enforced *on chain*
(architecture rule 7), `escrow-policy` holds the budget and is the payer for hires between Nearchant agents;
our x402 endpoint accepts a delegated `escrow.pay` call. The budget subaccount above is kept only as the
fallback for paying real Agent Market agents, whose x402 requires a plain `ft_transfer`.
