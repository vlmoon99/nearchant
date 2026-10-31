# NEAR contracts — M0 interface spec

Prose spec for the six M0 contracts. Code in `contracts/<name>/` follows this; a change here comes first.
Common to all: Rust + `near-sdk`, built with `cargo-near` (reproducible), tested with `near-workspaces`.
Amounts are `U128` strings, times are block timestamps in nanoseconds (`U64`), events are NEP-297 with
`standard: "nearchant"`, `version: "1.0.0"`. Every contract has an `owner` (the platform account) that can
upgrade code and change platform parameters, never move users' funds.

Accounts on testnet (`<root>` = `nearchant.testnet`, from `config/defaults/accounts.yaml`):
`nusd.<root>`, `orders.<root>`, `billing.<root>`, `proofs.<root>`, `escrow.<root>`, `treasury.<root>`,
`relayer.<root>`; the `handles` factory lives on `<root>` itself.

---

## `nusd` — test token

NEP-141 + NEP-145 + NEP-148 metadata (`symbol: "nUSD"`, `name: "Nearchant TEST dollar"`, `decimals: 6`).

- `faucet() -> U128` — mints `faucet_amount` (default 100 nUSD) to the caller, once per `faucet_period`
  (default 24 h) per account. Registers the caller's storage if needed (paid by the contract).
- `faucet_for(account_id)` — same, callable only by `relayer.<root>`, so sponsored accounts start funded.
- Owner: `set_faucet(amount, period)`.
- Event: `faucet_minted { account_id, amount }`.

Mainnet replaces this with real USDC by config; nothing else depends on `faucet`.

## `handles` — handle factory on `<root>`

Record per handle: `owner_id`, `account_id` (the subaccount or a linked account), `payout_account_id`,
`payout_token_id`, `card { name, bio, avatar_hash, links[] }`, `gateway_url?`, `embed_origins[]`,
`status: active | suspended`, `created_at`, `card_published_at?`.

- `claim(handle, public_key, card)` (payable) — validates the name (`a-z 0-9 - _`, 2–32 chars, not reserved),
  creates `<handle>.<root>` with **the seller's key as full access**, funds it with the attached deposit minus
  storage, stores the record with `owner_id = predecessor`.
- `claim_for(handle, owner_public_key, card)` — the same, callable only by `relayer.<root>`; the platform pays
  the deposit (testnet sponsorship, ADR 0001).
- `link(handle, account_id, card)` — maps a handle to an account the caller already owns
  (`predecessor == account_id`), no subaccount created.
- Owner-of-handle only: `set_card`, `set_payout(account_id, token_id)`, `set_gateway_url`, `set_embed_origins`.
- Platform owner only: `add_reserved(names[])`, `suspend(handle, reason)`, `unsuspend(handle)`.
- Views: `get_handle(handle)`, `get_handles_by_owner(account_id)`, `is_reserved(name)`.
- Events: `handle_claimed`, `handle_updated { fields[] }`, `handle_suspended`, `handle_unsuspended`.
  The gateway's handle cache is fed only by these.
- Reserved list ships with the names in `architecture.md` §13 plus the platform contract labels.
- Squatting rule (claims expire if no card is published) is **not in M0**; `card_published_at` is stored so it can
  be added.

## `orders` — buyer payments held until delivery

Order: `id`, `buyer_id`, `seller_handle`, `payout_account_id`, `token_id`, `amount`, `status`,
`created_at`, `delivered_at?`, `proof_id?`, `revisions_used`, `release_after_ns`.
Status: `held → delivered → released`, with `delivered → revision_requested → delivered`,
`delivered → refund_requested → refunded | released`.

- `ft_on_transfer(sender_id, amount, msg)` — the only way to create an order. `msg` is
  `{"order_id": "...", "seller_handle": "alice"}`. Only accepted tokens (`nusd` in M0). Looks up the payout
  account from `handles` (cross-contract), creates the order as `held`. Duplicate `order_id` → returns the full
  amount (refund via NEP-141 resolve) — this makes checkout retries safe.
- `mark_delivered(order_id, proof_id)` — caller must be the seller's account (`<handle>.<root>`; the seller's agent
  signs with a function-call key on that account scoped to this contract). Checks with `proofs.is_passed(proof_id,
  order_id)` before moving to `delivered`.
- Buyer: `accept(order_id)` → `released` (pays out), `request_revision(order_id)` (max `max_revisions`, default 1)
  → `revision_requested`, `request_refund(order_id)` after revisions are used → `refund_requested`.
- Seller: `approve_refund(order_id)` → `refunded`; `decline_refund(order_id)` → stays `refund_requested` for a
  manual dispute (M0 has no on-chain arbitration).
- Anyone: `release_expired(order_id)` — if `delivered` and `now > delivered_at + release_after_ns`, release.
  The gateway calls it on a timer.
- Owner: `set_params(release_after_ns_default, max_revisions, accepted_tokens[], commerce_fee_bps)`.
  `commerce_fee_bps` is 0 in M0.
- Events: `order_created`, `order_delivered`, `order_revision_requested`, `order_refund_requested`,
  `order_released`, `order_refunded`.
- Storage: the platform pre-funds the contract for order storage in M0.

## `billing` — prepaid balances for metered inference

- `ft_on_transfer(sender_id, amount, msg = {"action": "top_up", "account_id"?})` → adds to the balance of
  `account_id` (default `sender_id`).
- `set_caps(daily, monthly)` — by the account itself. `0` = no cap.
- `settle_batch(batch_id, merkle_root, entries: [{account_id, amount}])` — only `relayer.<root>`. For each entry
  debits `min(amount, balance, remaining caps)`; the unpaid rest is reported in the event so the gateway stops
  hosted calls for that account. Debits go to `treasury.<root>`. `batch_id` is idempotent.
- `withdraw(amount)` — the account withdraws unused balance (ft_transfer back).
- Views: `get_account(account_id) -> { balance, daily_cap, monthly_cap, spent_today, spent_month }`,
  `get_batch(batch_id) -> { merkle_root, settled_at }`.
- Events: `balance_topped_up`, `usage_settled { batch_id, merkle_root, account_id, charged, unpaid }`,
  `balance_withdrawn`.
- Usage records are signed by the gateway; the leaves of the Merkle tree are the hashes of those records, so a
  seller can prove any single charge against the posted root.

## `proof-log` — what was produced, by what, and whether it passed review

Entry: `proof_id` (assigned), `author_id` (predecessor), `task_id`, `order_id?`, `brief_hash`, `producer`
(`model:<id>` or `workflow:<id>@<hash>`), `output_hash`, `attestation_ref?`, `review { passed, reviewer_hash }`,
`created_at`.

- `record(entry) -> proof_id` — anyone may write; the author is the caller. Consumers trust an entry only if its
  author is the party they expect (the seller's account for orders).
- Views: `get(proof_id)`, `is_passed(proof_id, order_id) -> bool` (true only if the entry exists, `review.passed`,
  and `order_id` matches; used by `orders`).
- Event: `proof_recorded`.
- `verify(proof_id) -> bool` from `architecture.md` §12 maps to `is_passed`; TEE signature checks happen in the
  gateway in M0 and the attestation ref is stored for anyone to re-check.

## `escrow-policy` — campaign budgets and agent hires

Campaign: `campaign_id`, `seller_handle`, `owner_id`, `token_id`, `budget`, `spent`, `policy`, `status`.
Policy: `auto_limit` (per payment, default 2 nUSD), `daily_limit` (default 20 nUSD), `allowlist[]` (payee
accounts), `approver_id` (the seller).

**This contract holds the campaign budget and is the payer**, so caps, allowlist and thresholds are enforced on
chain (`architecture.md` §3 rule 7). This refines ADR 0009, see "Interop note" below.

- `ft_on_transfer(sender_id, amount, msg = {"action": "fund", "campaign_id", "policy"})` — creates or tops up a
  campaign owned by `sender_id`.
- `pay(campaign_id, payee_id, amount, memo)` — callable by the campaign's agent account (a function-call key
  scoped to `escrow.<root>`, method `pay`). If `amount ≤ auto_limit`, payee allowlisted and the daily limit not
  exceeded → transfers now. Otherwise creates a `pending` payment for approval.
- `approve(payment_id)` / `reject(payment_id)` — by `approver_id`.
- Fee: if `payee_id` is a Nearchant handle account, 5% (`agent_fee_bps = 500`) goes to `treasury.<root>`;
  otherwise no fee.
- `close(campaign_id)` — by the owner: refunds `budget - spent` and closes.
- Owner (platform): `set_agent_fee_bps`.
- Events: `campaign_funded`, `payment_made`, `payment_pending`, `payment_approved`, `payment_rejected`,
  `campaign_closed`.

**Interop note (x402).** The Agent Market's x402 expects a signed delegated `ft_transfer` from the payer. Our own
x402 endpoint (agent ↔ agent between Nearchant sellers, used in the M0 demo) accepts a delegated `escrow.pay`
call instead, so the policy stays on chain. Paying a real market agent on mainnet needs a plain `ft_transfer`;
for that case a campaign subaccount (ADR 0009) with balance-as-cap plus the off-chain Guardian is the fallback.
