#!/usr/bin/env python3
"""Mac standby watchdog (ADR 0020). Runs under launchd (setup.sh installs it).

standby  — the Spark serves nearchant.com. Every 15 s: is the Spark up? Every 60 s: copy new media from the Spark.
           The database follows the Spark by itself (streaming replica).
           Takeover when, for 3 minutes in a row: the Spark does not answer on the tailnet, nearchant.com does not answer
           in public either, and this Mac does reach the internet (so a Mac that is the one offline never takes over).
           Takeover = promote the replica, start the site (profile `active`, incl. the Cloudflare tunnel).
primary  — the Mac serves. Whenever the Spark is reachable over SSH again, its gateway, worker and tunnel are stopped
           (they also wait by themselves: their FENCE_URL asks /role here). Switching back is manual: failback.sh.
failback — failback.sh is moving the data back; the watchdog does nothing.

GET http://<STANDBY_IP>:8799/role → "standby" | "primary" | "failback";  /status → JSON.
"""
import http.server, json, os, subprocess, sys, threading, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = Path.home() / "Library/Application Support/nearchant-standby"
ROLE_FILE = STATE / "role"
TICK_S, SYNC_EVERY_S, TAKEOVER_AFTER_S = 15, 60, 180


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


def http_ok(url: str, timeout: float = 5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


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
    if role() == "primary":
        compose("--profile", "active", "up", "-d")  # after a Mac restart while primary
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
                fence_spark()
        except Exception as e:  # keep watching whatever happens
            log(f"error: {e}")
        time.sleep(TICK_S)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "sync-once":
        print("ok" if sync_media() else status["last_sync_error"])
    else:
        main()
