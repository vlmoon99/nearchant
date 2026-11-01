#!/usr/bin/env bash
# Dev only: runs gateway + worker natively with keys read from the macOS Keychain (never written to disk).
set -euo pipefail
cd "$(dirname "$0")/.."
k() { security find-generic-password -a nearchant -s "$1" -w; }
export DATABASE_URL=postgres://nearchant:nearchant-dev@127.0.0.1:55432/nearchant
export NEARCHANT_SECRET_KEY="$(k NEARCHANT_SECRET_KEY)" NEAR_RELAYER_KEY="$(k NC_RELAYER_KEY)"
export NEARAI_API_KEY="$(k NEARAI_API_KEY)" NC_LOCAL_LLM_KEY="$(k NC_LOCAL_LLM_KEY)"
export SEARXNG_URL=http://100.64.0.1:8888 RENDERER_URL=http://127.0.0.1:8081 MEDIA_DIR="$PWD/.media" MEDIA_PUBLIC=/media
export PUBLIC_URL=http://localhost:8787 PORT=8787
case "${1:-}" in
  gateway) exec node apps/gateway/dist/main.js ;;
  worker) exec node apps/worker/dist/main.js ;;
  *) echo "usage: $0 gateway|worker"; exit 2 ;;
esac
