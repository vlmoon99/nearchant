CONTRACTS := nusd handles proof-log orders billing escrow-policy
COMPOSE := docker compose -f deploy/local/compose.yaml

.PHONY: help demo contracts test-contracts build test up down logs doctor

help: ## list targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

demo: ## full deck pipeline on recorded model answers (Docker only) → .media/demo-deck/deck.{pdf,pptx,html}
	mkdir -p .media
	NEARCHANT_SECRET_KEY=demo-not-used-0000000000000000000000 $(COMPOSE) --profile demo run --rm --build demo
	$(COMPOSE) --profile demo stop demo-renderer >/dev/null
	@ls -la .media/demo-deck/

contracts: ## build every contract to contracts/target/near/<name>/<name>.wasm
	@set -e; for c in $(CONTRACTS); do (cd contracts/$$c && cargo near build non-reproducible-wasm); done

test-contracts: contracts ## near-workspaces sandbox tests for every contract
	cd contracts/tests && cargo test

build: ## install + build all TypeScript packages and apps
	corepack enable && pnpm install --frozen-lockfile && pnpm -r --filter "./packages/*" build && pnpm --filter @nearchant/gateway --filter @nearchant/worker build

test: build ## TypeScript tests (packages/db needs `make up` for Postgres)
	pnpm -r test

up: ## full local stack: Postgres, gateway, worker, renderer (needs NEARCHANT_SECRET_KEY)
	$(COMPOSE) up -d --build

down: ## stop the local stack
	$(COMPOSE) down

logs: ## follow gateway + worker logs
	$(COMPOSE) logs -f gateway worker

doctor: ## check the local stack and model endpoints
	@curl -sf http://localhost:8787/health && echo || echo "gateway: down"
	@$(COMPOSE) ps --format '{{.Service}}: {{.Status}}'
