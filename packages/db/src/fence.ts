// Standby fence (ADR 0020): the Mac standby takes over when the Spark is down. When the Spark comes back it must not
// serve from its stale database, so its gateway and worker ask the standby's watchdog (FENCE_URL, e.g.
// http://100.64.0.8:8799/role) before starting and wait while it answers "primary". An unreachable watchdog means
// the standby is off or still standing by — then this node is the primary and starts.

export interface FenceOpts { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (m: string) => void; intervalMs?: number; timeoutMs?: number }

export async function standbyRole(url: string, o: FenceOpts = {}): Promise<string | null> {
  try {
    const r = await (o.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}

/** Resolves once no other node claims to be primary. */
export async function waitWhileFenced(url: string | undefined, o: FenceOpts = {}): Promise<void> {
  if (!url) return;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let warned = false;
  while ((await standbyRole(url, o)) === "primary") {
    if (!warned) { (o.log ?? console.warn)(`[fence] the standby at ${url} is primary — waiting (run deploy/standby/failback.sh to switch back)`); warned = true; }
    await sleep(o.intervalMs ?? 15_000);
  }
}
