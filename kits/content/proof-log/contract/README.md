# Proof-log contract

A standalone Rust crate (`near-sdk` 5.30) — what it does and how to deploy it are in the [kit README](../README.md).

## Build

```sh
cargo near build non-reproducible-wasm   # → target/near/proof_log.wasm (+ proof_log_abi.json)
```

## Test

```sh
cargo test
```

Builds the wasm with cargo-near, starts a local NEAR sandbox per test and runs the 4 tests in `tests/proof_log.rs`.
The first run downloads the sandbox binary and compiles a lot (a few minutes). To reuse a sandbox binary you already
have, set `NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox`.

Needs: Rust with the `wasm32-unknown-unknown` target and `cargo-near` (`cargo install cargo-near`).

## Methods

| Method | Who | Notes |
|---|---|---|
| `new()` | deployer (init) | |
| `record(entry)` | anyone, payable | `entry = {content_hash, producer?, subject?, passed?, metadata?}`; author = caller; returns the id; excess deposit refunded |
| `get(id)` | view | |
| `get_next_id()` | view | entries so far = next id − 1 |
| `list_by_author(author_id, from_index?, limit?)` / `count_by_author(author_id)` | view | oldest first, ≤ 100 per page |
| `find_by_hash(content_hash, from_index?, limit?)` | view | oldest first: the first is the earliest proof |
| `is_passed(proof_id, subject, author_id)` | view | exists + same subject + same author + `passed != false` |
