# Security notes

An independent review (2026-11-01) found 14 issues; the fixes are in git history. This file lists what was fixed
and what is a known, accepted limitation for the testnet M0.

## Fixed

| # | Issue | Fix |
|---|---|---|
| H1 | Buyer-wallet rate limit checked after the relayer had paid | per-IP + daily limits run before any NEAR is sent, only for new wallets |
| H2 | Revision request + old deadline → deck kept and full refund | `request_revision` gives a fresh delivery window; the worker redelivers revisions |
| H3 | Public manage page listed order ids (= access to buyers' decks) | dashboard needs a seller signature; order ids are random UUIDs |
| H4 | Failed net payout still sent the 5% fee (drains escrow) | net first, fee only in the success callback (orders + escrow) |
| M1 | Free storage writes (link, tiny orders/campaigns, nUSD unregister refund) | storage deposit for `link`, minimum order 0.1 / campaign 1 nUSD, no unregister |
| M2 | A2A payment could be redeemed by a front-runner with another prompt | payment memo binds the task text hash; paid results are cached for retries |
| M3 | Rate limits trusted spoofable forwarding headers | proxy headers only with `TRUST_PROXY=cloudflare` (or `forwarded`) |
| M4 | Seller signatures not bound to the request | signed message carries a hash of the body fields |
| M5 | Unlimited Telegram chat calls billed to the seller | per-chat limit (10 per 10 minutes) |
| L3 | `/media/..` path traversal | order part must be `[A-Za-z0-9_-]+` |
| L4 | Model-written image links made the renderer fetch any URL | only the deck's own cover image survives `cleanDeck` |

## Known limitations (testnet M0)

- **proof-log writes are free** (agent function-call keys can't attach deposits). Spam costs the platform storage;
  acceptable on testnet, needs a per-author quota before mainnet.
- **Usage is charged after the fact** (L1): a seller can withdraw before a batch settles. M0 reports `unpaid` in the
  settlement event but doesn't yet stop hosted calls for that seller.
- **Campaign id `<handle>-main` is first-come** (L2): someone could pre-create it. Namespace by owner before mainnet.
- **Concurrent `createShop` for the same handle** (L5) can overwrite sealed agent keys of the winner; the second
  `claim_for` fails on chain, but the keys row is replaced. Low likelihood (per-IP + daily limits).
- **A crash between `escrow.pay` and saving the step** (L6) can pay a hire twice on retry. Low likelihood; the spend
  policy still caps it.
- Deliverables are protected only by an unguessable order id (capability URL).
