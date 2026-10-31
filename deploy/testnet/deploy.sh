#!/usr/bin/env bash
# Deploys (or upgrades) every M0 contract to testnet. Idempotent: existing accounts are reused,
# init runs only on first deploy. Keys come from the macOS Keychain (near-cli-rs), never from files.
#   ./deploy/testnet/deploy.sh            # deploy all
#   ./deploy/testnet/deploy.sh orders     # deploy one
set -euo pipefail
cd "$(dirname "$0")/../.."
NET=testnet
ROOT=nearchant.testnet
W=contracts/target/near
near_() { near "$@" network-config $NET sign-with-keychain send >/dev/null; }

exists() { near account view-account-summary "$1" network-config $NET now >/dev/null 2>&1; }

ensure_account() { # name amount
  local id="$1.$ROOT"
  if ! exists "$id"; then
    echo "create $id ($2)"
    near account create-account fund-myself "$id" "$2" autogenerate-new-keypair save-to-keychain \
      sign-as $ROOT network-config $NET sign-with-keychain send >/dev/null
  fi
}

# deploy <account> <wasm> <init-json> <view-method>
# Always (re)deploys the code, then runs `new` (signed by the contract account; init is #[private])
# only if the contract reports "not initialized". Upgrades keep state.
deploy() {
  local acc="$1" wasm="$W/$2/$2.wasm" init="$3" probe="$4"
  echo "deploy $acc"
  near_ contract deploy "$acc" use-file "$wasm" without-init-call
  if near contract call-function as-read-only "$acc" "$probe" json-args '{}' network-config $NET now 2>&1 | grep -q "not initialized"; then
    echo "  init $acc"
    near_ contract call-function as-transaction "$acc" new json-args "$init" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$acc"
  fi
}

ONLY="${1:-all}"
want() { [ "$ONLY" = all ] || [ "$ONLY" = "$1" ]; }

make contracts >/dev/null

ensure_account relayer '1 NEAR'
ensure_account treasury '0.1 NEAR'
want nusd    && { ensure_account nusd '2.2 NEAR';    deploy nusd.$ROOT nusd "{\"owner_id\":\"$ROOT\",\"relayer_id\":\"relayer.$ROOT\"}" ft_metadata; }
want proofs  && { ensure_account proofs '1.7 NEAR';  deploy proofs.$ROOT proof_log '{}' get_next_id; }
want orders  && { ensure_account orders '2.4 NEAR';  deploy orders.$ROOT orders "{\"owner_id\":\"$ROOT\",\"handles_id\":\"$ROOT\",\"proofs_id\":\"proofs.$ROOT\",\"treasury_id\":\"treasury.$ROOT\",\"accepted_tokens\":[\"nusd.$ROOT\"]}" get_params; }
want billing && { ensure_account billing '2.2 NEAR'; deploy billing.$ROOT billing "{\"owner_id\":\"$ROOT\",\"relayer_id\":\"relayer.$ROOT\",\"token_id\":\"nusd.$ROOT\",\"treasury_id\":\"treasury.$ROOT\"}" treasury_owed; }
want escrow  && { ensure_account escrow '2.4 NEAR';  deploy escrow.$ROOT escrow_policy "{\"owner_id\":\"$ROOT\",\"token_id\":\"nusd.$ROOT\",\"treasury_id\":\"treasury.$ROOT\",\"handles_root\":\"$ROOT\"}" get_agent_fee_bps; }
want handles && deploy $ROOT handles "{\"owner_id\":\"$ROOT\",\"relayer_id\":\"relayer.$ROOT\",\"agent_receivers\":[\"orders.$ROOT\",\"proofs.$ROOT\",\"escrow.$ROOT\"]}" get_params

# Platform contracts must be able to hold nUSD.
if [ "$ONLY" = all ] || [ "$ONLY" = nusd ]; then
  for a in orders billing escrow treasury relayer; do
    near_ contract call-function as-transaction nusd.$ROOT register json-args "{\"account_id\":\"$a.$ROOT\"}" \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ROOT
  done
fi
echo done
