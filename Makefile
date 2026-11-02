CONTRACTS := nusd handles proof-log orders billing escrow-policy
COMPOSE := docker compose -f deploy/local/compose.yaml

.PHONY: help demo demo-deck contracts test-contracts build test up down logs doctor

help: ## list targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

demo: export NEARCHANT_SECRET_KEY = demo-not-used-0000000000000000000000
demo: export DEMO_UID := $(shell id -u)
demo: export DEMO_GID := $(shell id -g)
demo: ## the content store (ADR 0018) on recorded answers (Docker only): photos → AI profile → opportunities → 3 posts with pictures → .media/demo-store/index.html
	mkdir -p .media
	$(COMPOSE) --profile demo run --rm --build demo-store
	@ls -la .media/demo-store/

demo-deck: export NEARCHANT_SECRET_KEY = demo-not-used-0000000000000000000000
demo-deck: export DEMO_UID := $(shell id -u)
demo-deck: export DEMO_GID := $(shell id -g)
demo-deck: ## the first demo service (investor deck pipeline) on recorded answers → .media/demo-deck/deck.{pdf,pptx,html}
	mkdir -p .media
	$(COMPOSE) --profile demo run --rm --build demo
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

# Mac standby (ADR 0020, deploy/standby/README.md)
standby-setup: ## Mac standby: replica of the Spark DB + media, watchdog that takes over nearchant.com when the Spark is down
	deploy/standby/setup.sh

standby-build: ## rebuild the Mac standby images from this checkout (after deploying new code to the Spark)
	docker compose -f deploy/standby/compose.yaml --env-file deploy/standby/.env --profile active build

standby-status: ## role, last Spark check, last media copy, replica lag
	@curl -s http://127.0.0.1:8799/status || echo "watchdog: not running"
	@docker compose -p nearchant-standby exec -T db psql -U nearchant -d nearchant -Atc "select case when pg_is_in_recovery() then 'replica, last change replayed ' || coalesce((now() - pg_last_xact_replay_timestamp())::text || ' ago', '?') else 'PRIMARY (serving)' end"

failback: ## after a takeover: move the data back and serve nearchant.com from the Spark again
	deploy/standby/failback.sh
