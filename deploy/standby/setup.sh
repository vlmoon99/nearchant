#!/bin/sh
# One-time (and safe to re-run) setup of the Mac standby (ADR 0020):
#   1. ./.env from the Keychain (git-ignored, chmod 600)
#   2. the Spark: replication role + slot, the database on its tailnet IP for this Mac only, FENCE_URL, rsync image
#   3. this Mac: build the images, start the replica (clones the Spark on first start), install the watchdog (launchd)
# Usage: deploy/standby/setup.sh            (from the repo root, the Spark online)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PRIMARY_HOST=${PRIMARY_HOST:-100.64.0.13}
SPARK_SSH=${SPARK_SSH:-server@$PRIMARY_HOST}
SPARK_DIR=${SPARK_DIR:-'~/nearchant/deploy/local'}  # ~ expands on the Spark
STANDBY_IP=${STANDBY_IP:-$(tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4)}
STANDBY_MEDIA=${STANDBY_MEDIA:-$HOME/nearchant-standby/media}
kc() { security find-generic-password -a nearchant -s "$1" -w 2>/dev/null; }

# 1 · secrets
if [ -z "$(kc NC_REPL_PASSWORD)" ]; then
  security add-generic-password -a nearchant -s NC_REPL_PASSWORD -w "$(openssl rand -hex 24)"
fi
umask 077
cat > "$HERE/.env" <<EOF
# Written by setup.sh from the macOS Keychain — never commit (git-ignored).
PRIMARY_HOST=$PRIMARY_HOST
SPARK_SSH=$SPARK_SSH
SPARK_DIR=$SPARK_DIR
STANDBY_IP=$STANDBY_IP
STANDBY_MEDIA=$STANDBY_MEDIA
REPL_PASSWORD=$(kc NC_REPL_PASSWORD)
NEARCHANT_SECRET_KEY=$(kc NEARCHANT_SECRET_KEY)
NEAR_RELAYER_KEY=$(kc NC_RELAYER_KEY)
NEARAI_API_KEY=$(kc NEARAI_API_KEY)
CF_TUNNEL_TOKEN=$(kc CF_TUNNEL_TOKEN)
COMFY_API_KEY=$(kc COMFY_API_KEY)
IMAGE_API_KEY=$(grep -s '^IMAGE_API_KEY=' "$HERE/.env.prev" | cut -d= -f2- || true)
EOF
grep -q '^IMAGE_API_KEY=.' "$HERE/.env" || sed -i '' "s/^IMAGE_API_KEY=.*/IMAGE_API_KEY=$(openssl rand -hex 16)/" "$HERE/.env"
cp "$HERE/.env" "$HERE/.env.prev"
mkdir -p "$STANDBY_MEDIA"
echo "1/3 .env written"

# 2 · the Spark (code pulled first: compose + fence)
ssh -o BatchMode=yes "$SPARK_SSH" "cd $SPARK_DIR && git -C ../.. pull -q --ff-only && \
  set_env() { grep -q \"^\$1=\" .env && sed -i \"s|^\$1=.*|\$1=\$2|\" .env || echo \"\$1=\$2\" >> .env; } && \
  set_env STANDBY_IP $STANDBY_IP && set_env FENCE_URL http://$STANDBY_IP:8799/role && \
  (grep -q '^COMPOSE_PROFILES=.*standby' .env || sed -i 's/^COMPOSE_PROFILES=\(.*\)/COMPOSE_PROFILES=\1,standby/' .env) && \
  printf 'FROM alpine:3.22\nRUN apk add --no-cache rsync\n' | docker build -q -t nearchant/rsync:1 - >/dev/null && \
  docker compose exec -T db sh -c 'grep -q \"replication replicator\" \$PGDATA/pg_hba.conf || echo \"host replication replicator all scram-sha-256\" >> \$PGDATA/pg_hba.conf'"
# The password travels on stdin, never on a command line.
printf "%s\n" \
  "do \$\$ begin if not exists (select from pg_roles where rolname = 'replicator') then create role replicator with replication login; end if; end \$\$;" \
  "alter role replicator with password '$(kc NC_REPL_PASSWORD)';" \
  "alter system set max_slot_wal_keep_size = '20GB';" \
  "select pg_reload_conf();" \
  "select pg_create_physical_replication_slot('mac_standby') where not exists (select from pg_replication_slots where slot_name = 'mac_standby');" \
  | ssh -o BatchMode=yes "$SPARK_SSH" "cd $SPARK_DIR && docker compose exec -T db psql -q -U nearchant -d nearchant -v ON_ERROR_STOP=1 >/dev/null"
ssh -o BatchMode=yes "$SPARK_SSH" "cd $SPARK_DIR && docker compose build -q gateway && docker compose up -d 2>&1 | tail -3"
echo "2/3 the Spark is ready (replication slot mac_standby, db on $PRIMARY_HOST:55432 for $STANDBY_IP only)"

# 3 · this Mac
cd "$HERE"
docker compose --env-file .env --profile active build -q
docker compose --env-file .env up -d db
# launchd may not read ~/Documents (macOS privacy): the watchdog runs from a copy outside it. The copy's compose
# file points its build contexts at this checkout (only used for builds, which run from here).
RUN=$(dirname "$STANDBY_MEDIA")/run
REPO=$(cd "$HERE/../.." && pwd)
mkdir -p "$RUN"
cp "$HERE/watchdog.py" "$HERE/db-entry.sh" "$HERE/.env" "$RUN/"
sed -e "s|context: \.\./\.\.|context: $REPO|" -e "s|context: \.\./image-engine/service|context: $REPO/deploy/image-engine/service|" "$HERE/compose.yaml" > "$RUN/compose.yaml"
python3 "$RUN/watchdog.py" sync-once
PLIST=$HOME/Library/LaunchAgents/com.nearchant.standby.plist
mkdir -p "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nearchant.standby</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$RUN/watchdog.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/nearchant-standby.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/nearchant-standby.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.nearchant.standby" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "3/3 standby running — status: curl -s http://127.0.0.1:8799/status ; log: ~/Library/Logs/nearchant-standby.log"
