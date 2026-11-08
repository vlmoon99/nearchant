#!/usr/bin/env python3
"""Mac standby watchdog (ADR 0020). Runs under launchd (setup.sh installs it).

standby  — the Spark serves nearchant.com. Every 15 s: is the Spark up? Every 60 s: copy new media from the Spark.
           The database follows the Spark by itself (streaming replica).
           Takeover when, for 3 minutes in a row: the Spark does not answer on the tailnet, nearchant.com does not answer
           in public either, and this Mac does reach the internet (so a Mac that is the one offline never takes over).
           Takeover = promote the replica, start the site (profile `active`, incl. the Cloudflare tunnel).
primary  — the Mac serves. Whenever the Spark is reachable over SSH again, its gateway, worker and tunnel are stopped
           (they also wait by themselves: their FENCE_URL asks /role here). Switching back is manual: failback.sh.
           Self-healing: if the site does not answer locally (Docker not started after a reboot, a crash), wait for
           Docker and start it again (every 2 min at most). Once a day: a database dump into backups/ (7 kept).
failback — failback.sh is moving the data back; the watchdog does nothing.

GET http://<STANDBY_IP>:8799/role → "standby" | "primary" | "failback";  /status → JSON.
"""
import http.server, json, os, subprocess, sys, threading, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = Path.home() / "Library/Application Support/nearchant-standby"
ROLE_FILE = STATE / "role"
TICK_S, SYNC_EVERY_S, TAKEOVER_AFTER_S = 15, 60, 180
RESTART_EVERY_S, BACKUP_EVERY_S, BACKUPS_KEPT = 120, 24 * 3600, 7
TUNNEL_AFTER_S = 60  # nearchant.com down this long while the local site works → restart the tunnel


def env() -> dict:
    out = {}
    f = HERE / ".env"
    for line in (f.read_text().splitlines() if f.exists() else []):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


CFG = env()
PRIMARY, STANDBY_IP, SSH = CFG.get("PRIMARY_HOST", ""), CFG.get("STANDBY_IP", "127.0.0.1"), CFG.get("SPARK_SSH", "")
SPARK_DIR, MEDIA = CFG.get("SPARK_DIR", "~/nearchant/deploy/local"), CFG.get("STANDBY_MEDIA", "")
status = {"role": None, "spark_ok_at": None, "last_sync": None, "last_sync_error": None, "down_since": None, "events": []}


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}"
    print(line, flush=True)
    status["events"] = (status["events"] + [line])[-30:]


def notify(msg: str) -> None:
    subprocess.run(["osascript", "-e", f'display notification "{msg}" with title "Nearchant standby"'], capture_output=True)


def role() -> str:
    try:
        return ROLE_FILE.read_text().strip() or "standby"
    except FileNotFoundError:
        return "standby"


def set_role(r: str) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = ROLE_FILE.with_suffix(".tmp")
    tmp.write_text(r)
    tmp.replace(ROLE_FILE)
    status["role"] = r


UA = "nearchant-watchdog/1"  # Cloudflare answers 403 to Python's default "Python-urllib/…" (7 Nov: tunnel restarted every 2 min)


def http_ok(url: str, timeout: float = 5) -> bool:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


# Contract accounts pay for their own storage: below this much free NEAR, writes fail with "lacks balance for state"
# (8 Nov: proofs ran out, so "mark shipped" and post proofs failed silently). The owner gets a notification.
NEAR_RPC = CFG.get("NEAR_RPC", "https://rpc.testnet.near.org")
WATCH_ACCOUNTS = [a for a in CFG.get("WATCH_ACCOUNTS", "nearchant.testnet,relayer.nearchant.testnet,proofs.nearchant.testnet,orders.nearchant.testnet,escrow.nearchant.testnet,billing.nearchant.testnet,nusd.nearchant.testnet").split(",") if a]
LOW_FREE_NEAR = float(CFG.get("LOW_FREE_NEAR", "1"))
BALANCE_EVERY_S = 3600


def free_near(amount_yocto: int, storage_bytes: int) -> float:
    """NEAR an account can still spend on storage and gas (1 byte of state locks 10^19 yocto)."""
    return (amount_yocto - storage_bytes * 10**19) / 1e24


def low_accounts(free: dict, limit: float = LOW_FREE_NEAR) -> list:
    return sorted(a for a, v in free.items() if v is not None and v < limit)


def check_balances() -> None:
    free = {}
    for a in WATCH_ACCOUNTS:
        try:
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "view_account", "finality": "final", "account_id": a}}).encode()
            req = urllib.request.Request(NEAR_RPC, data=body, headers={"content-type": "application/json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=10) as r:
                v = json.load(r)["result"]
            free[a] = round(free_near(int(v["amount"]), int(v["storage_usage"])), 2)
        except Exception:
            free[a] = None
    status["near_free"] = free
    low = low_accounts(free)
    if low:
        log(f"low NEAR balance: {', '.join(f'{a} {free[a]}' for a in low)} — top up from the root account")
        notify(f"Low NEAR: {', '.join(low)}")


def run(*cmd: str, timeout: float = 600, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout, **kw)


def compose(*args: str, timeout: float = 900) -> subprocess.CompletedProcess:
    return run("docker", "compose", "-f", str(HERE / "compose.yaml"), "--env-file", str(HERE / ".env"), *args, timeout=timeout)


def ssh(cmd: str, timeout: float = 60) -> subprocess.CompletedProcess:
    return run("ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", SSH, cmd, timeout=timeout)


# The Spark keeps media in a Docker volume; rsync on its side runs in a tiny container that mounts it.
REMOTE_RSYNC = "docker run --rm -i -v nearchant_media:/m nearchant/rsync:1 rsync"


def sync_media(push: bool = False) -> bool:
    Path(MEDIA).mkdir(parents=True, exist_ok=True)
    src, dst = (f"{MEDIA}/", f"{SSH}:/m/") if push else (f"{SSH}:/m/", f"{MEDIA}/")
    r = run("rsync", "-rt", "--rsync-path", REMOTE_RSYNC, "-e", "ssh -o ConnectTimeout=6 -o BatchMode=yes", src, dst, timeout=1800)
    status["last_sync" if r.returncode == 0 else "last_sync_error"] = time.strftime("%Y-%m-%dT%H:%M:%S%z") + ("" if r.returncode == 0 else f" {r.stderr[-300:]}")
    return r.returncode == 0


def should_take_over(spark_tailnet_ok: bool, site_public_ok: bool, internet_ok: bool, down_for_s: float) -> bool:
    """Pure rule, unit-tested in test_watchdog.py."""
    return not spark_tailnet_ok and not site_public_ok and internet_ok and down_for_s >= TAKEOVER_AFTER_S


def should_restart(site_ok: bool, since_last_try_s: float) -> bool:
    """Pure rule, unit-tested in test_watchdog.py: the Mac is primary and its site does not answer locally."""
    return not site_ok and since_last_try_s >= RESTART_EVERY_S


def should_restart_tunnel(local_ok: bool, public_ok: bool, internet_ok: bool, public_down_s: float,
                          since_last_try_s: float) -> bool:
    """Pure rule, unit-tested: the site works on this Mac but not on nearchant.com (the Cloudflare tunnel lost its
    connection and did not get it back, as on 7 Nov), and this Mac is online."""
    return local_ok and not public_ok and internet_ok and public_down_s >= TUNNEL_AFTER_S and since_last_try_s >= RESTART_EVERY_S


def docker_ready(wait_s: float = 300) -> bool:
    """Docker Desktop may still be starting after a login: open it and wait."""
    if run("docker", "info", timeout=30).returncode == 0:
        return True
    run("open", "-a", "Docker", timeout=30)
    end = time.time() + wait_s
    while time.time() < end:
        time.sleep(5)
        if run("docker", "info", timeout=30).returncode == 0:
            return True
    return False


def restart_site(why: str = "site was down") -> None:
    if not docker_ready():
        log("site down and Docker does not start — will retry")
        notify("nearchant.com is down: Docker does not start on this Mac")
        return
    r = compose("--profile", "active", "up", "-d")
    log(f"{why} — started it: rc={r.returncode} {r.stderr.strip()[-200:]}")
    if r.returncode != 0:
        notify("nearchant.com is down: docker compose up failed (see ~/Library/Logs/nearchant-standby.log)")


def restart_tunnel() -> None:
    r = compose("restart", "tunnel", timeout=120)
    log(f"nearchant.com did not answer but the local site did — restarted the tunnel: rc={r.returncode}")
    if r.returncode != 0:
        notify("nearchant.com is down: restarting the Cloudflare tunnel failed")


def backup_db() -> None:
    d = HERE.parent / "backups"
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"nearchant-{time.strftime('%Y%m%d-%H%M')}.sql.gz"
    with open(out, "wb") as f:
        dump = subprocess.Popen(["docker", "compose", "-f", str(HERE / "compose.yaml"), "--env-file", str(HERE / ".env"), "exec", "-T", "db",
                                 "pg_dump", "-U", "nearchant", "-d", "nearchant"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        gz = subprocess.run(["gzip", "-c"], stdin=dump.stdout, stdout=f)
        dump.wait()
    if dump.returncode != 0 or gz.returncode != 0 or out.stat().st_size < 1000:
        out.unlink(missing_ok=True)
        log("backup failed")
        return
    for old in sorted(d.glob("nearchant-*.sql.gz"))[:-BACKUPS_KEPT]:
        old.unlink()
    log(f"backup {out.name} ({out.stat().st_size // 1024} KB)")


def take_over() -> None:
    log("TAKEOVER: the Spark has been down for 3 minutes — promoting the standby database and starting the site")
    set_role("primary")  # first: the Spark must already see "primary" if it comes back mid-way
    r = compose("exec", "-T", "db", "psql", "-U", "nearchant", "-d", "nearchant", "-Atc", "select pg_promote(true, 60)")
    log(f"promote: {(r.stdout or r.stderr).strip()[:200]}")
    r = compose("--profile", "active", "up", "-d")
    log(f"site up: rc={r.returncode} {r.stderr.strip()[-300:]}")
    notify("nearchant.com now runs on this Mac (the Spark is down)")


def fence_spark() -> None:
    r = ssh(f"cd {SPARK_DIR} && docker compose ps -q --status running gateway worker tunnel | wc -l")
    if r.returncode == 0 and r.stdout.strip() not in ("", "0"):
        s = ssh(f"cd {SPARK_DIR} && docker compose stop gateway worker tunnel", timeout=180)
        log(f"the Spark is back while this Mac is primary — stopped its gateway/worker/tunnel (rc={s.returncode}). Run failback.sh to switch back.")
        notify("The Spark is back. nearchant.com stays on this Mac until you run failback.sh")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body, ctype = (role(), "text/plain") if self.path == "/role" else (json.dumps({**status, "role": role()}, indent=1), "application/json") if self.path == "/status" else (None, None)
        if body is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *a):
        pass


def serve() -> None:
    for host in (STANDBY_IP, "127.0.0.1"):
        while True:
            try:
                srv = http.server.ThreadingHTTPServer((host, 8799), Handler)
                threading.Thread(target=srv.serve_forever, daemon=True).start()
                break
            except OSError:  # the tailnet address is not up yet (boot, sleep)
                time.sleep(10)


def main() -> None:
    serve()
    status["role"] = role()
    log(f"watchdog started, role {role()}")
    last_ok, last_sync = time.time(), 0.0
    public_ok_at, last_tunnel_try = time.time(), 0.0
    last_restart_try, last_backup = 0.0, time.time() - BACKUP_EVERY_S + 600  # first backup 10 min after start
    last_balance = 0.0
    if role() == "primary":
        restart_site("watchdog start while primary")  # after a Mac restart (waits for Docker Desktop)
        last_restart_try = time.time()
    prev = role()
    while True:
        try:
            r = role()
            if r != prev:  # e.g. failback.sh finished: the 3-minute clock starts again from now
                log(f"role {prev} → {r}")
                last_ok, prev = time.time(), r
            if r == "standby":
                if http_ok(f"http://{PRIMARY}:8787/health"):
                    last_ok = time.time()
                    status["spark_ok_at"], status["down_since"] = time.strftime("%Y-%m-%dT%H:%M:%S%z"), None
                    if time.time() - last_sync >= SYNC_EVERY_S:
                        sync_media()
                        last_sync = time.time()
                else:
                    status["down_since"] = status["down_since"] or time.strftime("%Y-%m-%dT%H:%M:%S%z")
                    down = time.time() - last_ok
                    if down >= TAKEOVER_AFTER_S and should_take_over(False, http_ok("https://nearchant.com/health", 8),
                                                                     http_ok("https://www.cloudflare.com/cdn-cgi/trace", 8), down):
                        take_over()
            elif r == "primary":
                local_ok = http_ok("http://127.0.0.1:8797/health")
                if should_restart(local_ok, time.time() - last_restart_try):
                    last_restart_try = time.time()
                    restart_site()
                public_ok = local_ok and http_ok("https://nearchant.com/health", 10)
                if public_ok or not local_ok:
                    public_ok_at = time.time()
                elif should_restart_tunnel(local_ok, public_ok, http_ok("https://www.cloudflare.com/cdn-cgi/trace", 8),
                                           time.time() - public_ok_at, time.time() - last_tunnel_try):
                    last_tunnel_try = time.time()
                    restart_tunnel()
                if time.time() - last_balance >= BALANCE_EVERY_S:
                    last_balance = time.time()
                    check_balances()
                if time.time() - last_backup >= BACKUP_EVERY_S:
                    last_backup = time.time()
                    backup_db()
                if SSH:
                    fence_spark()
        except Exception as e:  # keep watching whatever happens
            log(f"error: {e}")
        time.sleep(TICK_S)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "sync-once":
        print("ok" if sync_media() else status["last_sync_error"])
    else:
        main()
