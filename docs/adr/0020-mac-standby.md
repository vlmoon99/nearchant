# ADR 0020 — Mac standby: the site survives a Spark outage

Status: accepted (2 Nov 2026)

## Context
nearchant.com runs on one Spark (gx10-8695): gateway, worker, Postgres, media, Cloudflare tunnel. On 2 Nov the
power went off at the Sparks' site and the whole product was down until it came back. The owner wants development
and the demo to go on from the Mac when that happens.

## Decision
- The Mac keeps a **streaming replica** of the Spark's Postgres (physical replication, slot `mac_standby`, the
  database on the Spark's tailnet IP for the Mac's address only, role `replicator` with a Keychain password) and
  **copies media** every minute (rsync over SSH).
- A **watchdog** on the Mac (launchd, `deploy/standby/watchdog.py`) takes over when, for 3 minutes, the Spark does not
  answer on the tailnet, nearchant.com does not answer in public, and the Mac itself is online. Takeover: promote the
  replica, start gateway + worker + the same Cloudflare tunnel on the Mac. Text AI then runs on NEAR AI Cloud
  (`providers.cloud.yaml`), pictures on Comfy Cloud; videos are off (no TTS on the Mac).
- **Fence**: a returning Spark must not serve its stale database. Its gateway and worker wait at start while the
  Mac's `/role` says `primary` (`FENCE_URL`, `waitWhileFenced` in `packages/db`), and the watchdog stops the Spark's
  gateway, worker and tunnel as soon as it can reach it over SSH.
- **Switching back is manual** (`make failback`): the Mac's database replaces the Spark's (the old one is kept as a
  dump), media is copied back, the Spark serves again and the Mac re-clones. Automatic failback could lose writes.

## Consequences
- An outage costs ~3–4 minutes of downtime instead of hours; switching back ~30 s plus the re-clone.
- Writes on the Spark in its last seconds before a crash, and media made in its last minute, can be missing.
- The Mac must be awake with Docker running; a Mac that stays off makes the Spark keep up to 20 GB of WAL
  (`max_slot_wal_keep_size`), then the replica must be re-cloned (`make standby-setup`).
- The Mac's images are built from its checkout: `make standby-build` after deploying new code to the Spark.
- While the Mac serves, text AI uses NEAR AI credit.
