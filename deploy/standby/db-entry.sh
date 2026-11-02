#!/bin/sh
# Standby database: on first start (empty data dir) clone the primary over the tailnet with pg_basebackup and follow
# it (standby.signal + primary_conninfo written by -R, slot mac_standby keeps the WAL we still need).
set -e
PGDATA=${PGDATA:-/var/lib/postgresql/data}
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
  until PGPASSWORD="$REPL_PASSWORD" gosu postgres pg_basebackup -h "$PRIMARY_HOST" -p "${PRIMARY_PORT:-55432}" -U replicator \
      -D "$PGDATA" -R -X stream -S mac_standby --progress; do
    echo "standby: primary not reachable yet, retrying in 30 s"; rm -rf "${PGDATA:?}"/* 2>/dev/null || true; sleep 30
  done
  echo "standby: cloned from $PRIMARY_HOST"
fi
exec docker-entrypoint.sh postgres
