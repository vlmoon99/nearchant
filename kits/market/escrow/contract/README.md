# Escrow contract

A standalone Rust crate (`near-sdk` 5.30) — what it does, the msg format and the state machine are in the
[kit README](../README.md).

## Build

```sh
cargo near build non-reproducible-wasm   # → target/near/escrow.wasm (+ escrow_abi.json)
```

Deploy and init commands: see "Deploy" in the kit README.

## Test

```sh
cargo test
```

Builds `escrow.wasm` and two test-only contracts in `tests/fixtures/` (`token`: a minimal NEP-141 anyone can mint;
`mocks`: a stand-in `get_handle` registry and `is_passed` proof log) with cargo-near, starts a local NEAR sandbox per
test and runs 13 tests in `tests/escrow.rs`. The first run downloads the sandbox binary and compiles a lot (a few
minutes); later runs take about a minute. To reuse a sandbox binary you already have, set
`NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox`.

Needs: Rust with the `wasm32-unknown-unknown` target and `cargo-near` (`cargo install cargo-near`).

## Methods

| Method | Who | Notes |
|---|---|---|
| `new(owner_id, accepted_tokens, fee_bps?, fee_account_id?, registry_id?, proof_log_id?, release_after_ns?, delivery_deadline_ns?, max_revisions?, min_amount?)` | deployer (init) | |
| `ft_on_transfer(sender_id, amount, msg)` | accepted token | creates the order; `msg = {"order_id","seller"}` |
| `mark_delivered(order_id, proof_id?)` | seller | returns `true` if delivered |
| `approve_refund(order_id)` / `decline_refund(order_id)` | seller | |
| `accept(order_id)` / `request_revision(order_id)` / `request_refund(order_id)` | buyer | `accept` returns `false` if the payout transfer failed |
| `release_expired(order_id)` / `refund_undelivered(order_id)` | anyone | after the windows |
| `get_order(order_id)` / `get_params()` / `get_owner()` | view | |
| `set_params(params)` | owner | new orders only; fee ≤ 1000 bps |
