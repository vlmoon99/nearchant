export interface BackoffOptions {
  /** First retry delay. Default 2 s. */
  baseMs?: number;
  /** Longest delay. Default 10 min. */
  maxMs?: number;
  /** ± share of the delay that is random, so many failed items don't retry at the same moment. Default 0.2. */
  jitter?: number;
  /** Random source in [0, 1) (for tests). Default Math.random. */
  random?: () => number;
}

/** Delay before the next try after `attempt` failed tries: base · 2^(attempt−1), capped, ± jitter. */
export function exponentialBackoff(o: BackoffOptions = {}): (attempt: number) => number {
  const base = o.baseMs ?? 2_000, max = o.maxMs ?? 600_000, jitter = o.jitter ?? 0.2, random = o.random ?? Math.random;
  return (attempt) => {
    const d = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
    return Math.max(0, Math.round(Math.min(max, d * (1 + jitter * (2 * random() - 1)))));
  };
}
