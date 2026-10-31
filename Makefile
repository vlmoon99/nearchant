CONTRACTS := nusd handles orders billing proof-log escrow-policy

.PHONY: contracts test-contracts
contracts: ## build every contract to contracts/target/near/<name>/<name>.wasm
	@for c in $(CONTRACTS); do [ -d contracts/$$c/src ] && [ -f contracts/$$c/Cargo.toml ] && (cd contracts/$$c && cargo near build non-reproducible-wasm --locked >/dev/null 2>&1 || cargo near build non-reproducible-wasm) || true; done

test-contracts: contracts ## sandbox tests for all contracts
	cd contracts/tests && cargo test
