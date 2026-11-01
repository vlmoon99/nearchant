#!/bin/sh
# The whole product in one run on a live site: new store → photos → analysis → opportunities → posts live →
# item for sale → a buyer pays into escrow → owner ships → buyer confirms → Released on NEAR.
#   sh e2e/journey.sh [baseUrl] [photosDir] [shotsDir]
set -eu
base=${1:-https://nearchant.com}; photos=${2:-$(dirname "$0")/../../../fixtures/replay/store/photos}; shots=${3:-/tmp/nc-journey}
mkdir -p "$shots"
line=$(LIST_ITEM=1 node "$(dirname "$0")/onboard.mjs" "$base" "$photos" "$shots" | tee /dev/stderr | grep '^STORE ')
set -- $line
node "$(dirname "$0")/buy-item.mjs" "$2" "$3" "$shots"
