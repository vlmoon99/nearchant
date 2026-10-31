# 0004 — `PaymentRail` interface

**Decision.** `packages/near` exposes `PaymentRail { quote, createPayment, status }` with two implementations:
- `testnet-direct`: the buyer's (sponsored) account calls `nusd.ft_transfer_call` to `orders` with the order id.
- `intents-1click`: tokens → dry quote → real quote with deposit address → deposit → status, via
  `1click.chaindefuser.com` (JWT optional; without one there is an extra fee).

The rail is chosen by config. On testnet, checkout also fetches a mainnet **dry** quote (free, no funds move) to
show "you would pay X from chain Y".

**Consequences.** Order state is always confirmed on chain before an order is marked paid, whatever the rail.
