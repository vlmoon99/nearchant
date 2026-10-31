CONTRACTS := nusd handles proof-log orders billing escrow-policy

.PHONY: contracts test-contracts
contracts: ## build every contract to contracts/target/near/<name>/<name>.wasm
	@set -e; for c in $(CONTRACTS); do (cd contracts/$$c && cargo near build non-reproducible-wasm); done

test-contracts: contracts ## near-workspaces sandbox tests for every contract
	cd contracts/tests && cargo test
