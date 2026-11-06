#!/bin/sh
# Mac-only mode (ADR 0023): nearchant.com runs on this Mac with every model in the cloud (NEAR AI TEE text + Sage,
# Comfy Cloud pictures), the Sparks switched off. Safe to re-run; it needs neither the Spark nor its SSH.
#   1. ./.env from the Keychain (+ admin password, voice key, voice weights)
#   2. Docker Desktop starts at login; the Mac never sleeps on power (launchd `caffeinate -s`)
#   3. the site (profile `active`) built and started; the watchdog restarted as `primary`
#      (it restarts the site if it stops answering and dumps the database daily into ~/nearchant-standby/backups)
# Usage: deploy/standby/mac-only.sh   (from the repo root)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
STANDBY_MEDIA=${STANDBY_MEDIA:-$HOME/nearchant-standby/media}
RUN=$(dirname "$STANDBY_MEDIA")/run
kc() { security find-generic-password -a nearchant -s "$1" -w 2>/dev/null; }
old() { grep -s "^$1=" "$HERE/.env" | cut -d= -f2- || true; }

# 1 · secrets (the Spark's address stays only so the watchdog can fence it if it ever comes back)
[ -n "$(kc NC_TTS_API_KEY)" ] || security add-generic-password -a nearchant -s NC_TTS_API_KEY -w "$(openssl rand -hex 16)"
IMAGE_KEY=$(old IMAGE_API_KEY); [ -n "$IMAGE_KEY" ] || IMAGE_KEY=$(openssl rand -hex 16)
umask 077
cat > "$HERE/.env.new" <<EOF
# Written by mac-only.sh / setup.sh from the macOS Keychain — never commit (git-ignored).
PRIMARY_HOST=$(old PRIMARY_HOST)
SPARK_SSH=$(old SPARK_SSH)
SPARK_DIR=$(old SPARK_DIR)
STANDBY_IP=$(old STANDBY_IP)
STANDBY_MEDIA=$STANDBY_MEDIA
REPL_PASSWORD=$(kc NC_REPL_PASSWORD)
NEARCHANT_SECRET_KEY=$(kc NEARCHANT_SECRET_KEY)
NEAR_RELAYER_KEY=$(kc NC_RELAYER_KEY)
NEARAI_API_KEY=$(kc NEARAI_API_KEY)
CF_TUNNEL_TOKEN=$(kc CF_TUNNEL_TOKEN)
COMFY_API_KEY=$(kc COMFY_API_KEY)
RESEND_API_KEY=$(kc RESEND_API_KEY)
IMAGE_API_KEY=$IMAGE_KEY
ADMIN_PASSWORD=$(kc NC_ADMIN_PASSWORD)
TTS_API_KEY=$(kc NC_TTS_API_KEY)
TTS_WEIGHTS=$HOME/nearchant-node/tts-weights
NVIDIA_API_KEY=$(kc NVIDIA_API_KEY)
NRAS_URL=$(kc NC_NRAS_URL)
EOF
mv "$HERE/.env.new" "$HERE/.env"
for k in NEARCHANT_SECRET_KEY NEARAI_API_KEY CF_TUNNEL_TOKEN COMFY_API_KEY ADMIN_PASSWORD; do
  grep -q "^$k=." "$HERE/.env" || echo "warning: $k is empty (Keychain)"
done
[ -f "$HOME/nearchant-node/tts-weights/kokoro/kokoro-v1.0.onnx" ] || echo "warning: no voice weights in ~/nearchant-node/tts-weights (videos will fail)"
echo "1/3 .env written"

# 2 · always on
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / "Library/Group Containers/group.com.docker/settings-store.json"
try:
    s = json.loads(p.read_text()); s["AutoStart"] = True; p.write_text(json.dumps(s, indent=2))
    print("Docker Desktop: starts at login")
except OSError:  # macOS privacy may block this; the watchdog opens Docker at login anyway
    print("note: turn on Docker Desktop → Settings → General → 'Start Docker Desktop when you sign in' (the watchdog also opens it)")
PY
AWAKE=$HOME/Library/LaunchAgents/com.nearchant.awake.plist
cat > "$AWAKE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nearchant.awake</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-s</string><string>-i</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.nearchant.awake" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AWAKE"
echo "2/3 no sleep while on power (closing the lid still sleeps a MacBook unless an external display is attached)"

# 3 · the site + the watchdog (runs from a copy outside ~/Documents, see setup.sh)
mkdir -p "$RUN" "$STANDBY_MEDIA" "$(dirname "$STANDBY_MEDIA")/backups"
cp "$HERE/watchdog.py" "$HERE/db-entry.sh" "$HERE/.env" "$RUN/"
sed -e "s|context: \.\./\.\.|context: $REPO|" -e "s|context: \.\./image-engine/service|context: $REPO/deploy/image-engine/service|" \
    -e "s|context: \.\./video-engine/tts|context: $REPO/deploy/video-engine/tts|" "$HERE/compose.yaml" > "$RUN/compose.yaml"
mkdir -p "$HOME/Library/Application Support/nearchant-standby"
printf primary > "$HOME/Library/Application Support/nearchant-standby/role"
docker info >/dev/null 2>&1 || { open -a Docker; until docker info >/dev/null 2>&1; do sleep 3; done; }
docker compose -f "$HERE/compose.yaml" --env-file "$HERE/.env" --profile active build -q
docker compose -f "$RUN/compose.yaml" --env-file "$RUN/.env" --profile active up -d
launchctl kickstart -k "gui/$(id -u)/com.nearchant.standby"
echo "3/3 nearchant.com runs on this Mac — status: curl -s http://127.0.0.1:8799/status ; admin: http://127.0.0.1:8790/mod"
