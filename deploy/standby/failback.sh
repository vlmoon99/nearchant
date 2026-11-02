#!/bin/sh
# Switch nearchant.com back from the Mac to the Spark after a takeover (ADR 0020). Run it on the Mac when the Spark
# is online again. A few minutes of downtime: the site is stopped on both while the data moves.
#   1. stop the Mac's site (the Spark stays fenced: role is still "primary")
#   2. back up the Spark's old database, replace it with the Mac's (pg_dump | pg_restore over SSH)
#   3. copy the media made on the Mac to the Spark
#   4. release the fence and start the Spark's site; wait for https://nearchant.com/health
#   5. turn the Mac back into a replica of the Spark (fresh clone) — role "standby"
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/.env"
STATE="$HOME/Library/Application Support/nearchant-standby"
role=$(cat "$STATE/role" 2>/dev/null || echo standby)
[ "$role" = primary ] || { echo "this Mac is not primary (role: $role) — nothing to switch back"; exit 1; }
dc() { docker compose -f "$HERE/compose.yaml" --env-file "$HERE/.env" "$@"; }
spark() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$SPARK_SSH" "cd $SPARK_DIR && $1"; }
spark "docker compose ps db --status running -q | grep -q ." || { echo "the Spark's database is not running"; exit 1; }
ts=$(date -u +%Y%m%dT%H%M%SZ)

echo "1/5 stopping the site on this Mac"
dc stop gateway worker tunnel

echo "2/5 database → the Spark (old one kept in ~/nearchant-backups/before-failback-$ts.dump on the Spark)"
spark "docker compose stop gateway worker tunnel >/dev/null 2>&1; mkdir -p ~/nearchant-backups && docker compose exec -T db pg_dump -U nearchant -Fc nearchant > ~/nearchant-backups/before-failback-$ts.dump"
spark "docker compose exec -T db psql -q -U nearchant -d postgres -c 'drop database nearchant with (force)' -c 'create database nearchant'"
dc exec -T db pg_dump -U nearchant -Fc nearchant | spark "docker compose exec -T db pg_restore -U nearchant -d nearchant --no-owner --exit-on-error"
echo "   restored: $(spark "docker compose exec -T db psql -U nearchant -d nearchant -Atc 'select count(*) from posts'") posts"

echo "3/5 media → the Spark"
rsync -rt --rsync-path "docker run --rm -i -v nearchant_media:/m nearchant/rsync:1 rsync" -e "ssh -o BatchMode=yes" "$STANDBY_MEDIA/" "$SPARK_SSH:/m/"

echo "4/5 starting the site on the Spark"
printf failback > "$STATE/role"
spark "docker compose up -d gateway worker tunnel 2>&1 | tail -1"
for i in $(seq 1 40); do curl -fsS -m 5 https://nearchant.com/health >/dev/null 2>&1 && break; sleep 5; done
curl -fsS -m 5 https://nearchant.com/health >/dev/null && echo "   https://nearchant.com is served by the Spark" || echo "   WARNING: nearchant.com does not answer yet — check the Spark"

echo "5/5 this Mac becomes a replica again"
dc --profile active rm -sf gateway worker tunnel image-cloud search renderer >/dev/null
dc rm -sf db >/dev/null
docker volume rm nearchant-standby_db >/dev/null
dc up -d db
printf standby > "$STATE/role"
echo "done — the Mac is standing by again (clone in progress: docker compose -p nearchant-standby logs -f db)"
