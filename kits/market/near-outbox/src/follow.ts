// "Show it live until NEAR has it": after a tap, poll the action's status and tell the page what to say. No DOM here:
// you get updates and render them however you like (a bar, a toast, a button state).
import { explainNearError } from "./near-error.js";
import type { ActionStatus } from "./types.js";

export type FollowPhase = "working" | "retrying" | "done" | "failed" | "gone" | "timeout" | "stopped";

export interface FollowUpdate {
  phase: FollowPhase;
  status: ActionStatus | null;
  /** Time since the action was queued (status.since, the tap), not since the page loaded. */
  elapsedMs: number;
  /** "12 s", "2 min 5 s". */
  elapsed: string;
  /** The NEAR error in plain words (empty when none). Keep status.error for support. */
  why: string;
}

export interface FollowOptions {
  /** Poll interval. Default 2 s; slows to `slowMs` after `slowAfterMs`. */
  intervalMs?: number;
  slowAfterMs?: number;
  slowMs?: number;
  /** Give up after this long (phase "timeout"). Default 30 min. */
  maxMs?: number;
  signal?: AbortSignal;
  /** When the user tapped, if known (ms). Used until the server's `since` arrives. Default now. */
  startedAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * Polls `fetchStatus` until the action is done or failed, calling `onUpdate` each time. `fetchStatus` returns the
 * action's status, `null` when nothing is on its way (done), or throws `{ status: 404 }` when the thing is gone.
 * Other fetch errors are ignored (the next poll tries again). Resolves with the last phase.
 */
export async function followAction(fetchStatus: () => Promise<ActionStatus | null>, onUpdate: (u: FollowUpdate) => void, o: FollowOptions = {}): Promise<FollowPhase> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let since = o.startedAt ?? t0;
  const emit = (phase: FollowPhase, status: ActionStatus | null) => {
    const elapsedMs = Math.max(0, now() - since);
    onUpdate({ phase, status, elapsedMs, elapsed: formatElapsed(elapsedMs), why: status?.error ? explainNearError(status.error) : "" });
    return phase;
  };
  for (;;) {
    if (o.signal?.aborted) return emit("stopped", null);
    let s: ActionStatus | null | undefined;
    try { s = await fetchStatus(); }
    catch (e) {
      if ((e as { status?: number })?.status === 404) return emit("gone", null);
      s = undefined; // network blip: keep polling
    }
    if (s) {
      // Count from the tap on the server, but never from the future (clock skew between server and browser).
      const t = Date.parse(s.since);
      if (Number.isFinite(t)) since = Math.min(t, now());
    }
    if (s === null || s?.state === "done") return emit("done", s ?? null);
    if (s?.state === "failed") return emit("failed", s);
    if (s !== undefined) emit(s.error && s.attempts > 0 ? "retrying" : "working", s);
    const ran = now() - t0;
    if (ran >= (o.maxMs ?? 30 * 60_000)) return emit("timeout", s ?? null);
    await sleep(ran > (o.slowAfterMs ?? 5 * 60_000) ? (o.slowMs ?? 10_000) : (o.intervalMs ?? 2_000));
  }
}
