# Mac standby (ADR 0020)

The Mac follows the Spark all the time and serves nearchant.com by itself when the Spark is down.

| Command | What it does |
|---|---|
| `make standby-setup` | one time (safe to re-run): `.env` from the Keychain, Spark replication + fence, clone, watchdog in launchd |
| `make standby-status` | role (`standby` / `primary`), last Spark check, last media copy, replica state |
| `make standby-build` | rebuild the Mac's images after deploying new code to the Spark |
| `make failback` | after a takeover, when the Spark is back: data → Spark, Spark serves, Mac re-clones |

- Watchdog log: `~/Library/Logs/nearchant-standby.log` (a macOS notification on takeover and when the Spark returns).
- It runs from `~/nearchant-standby/run/` (launchd may not read `~/Documents`); media copy in `~/nearchant-standby/media`.
- Takeover rule: Spark silent on the tailnet **and** nearchant.com down in public **and** this Mac online, 3 minutes.
- While the Mac is primary the Spark's gateway/worker/tunnel are stopped and wait (`FENCE_URL`) — never start them by
  hand; run `make failback`.
- Turn it off: `launchctl bootout gui/$(id -u)/com.nearchant.standby` and `docker compose -p nearchant-standby down`.
