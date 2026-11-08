export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** First backoff delay; doubles each attempt, plus jitter (default 300 ms). */
  retryDelayMs?: number;
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/** Rejects if `p` hasn't settled in `ms`. The underlying request may still finish; callers must allow for that. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Retries `fn` with exponential backoff. Use only for calls that are safe to repeat (reads). */
export async function retry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 3;
  const base = o.retryDelayMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, base * 2 ** attempt + Math.random() * base));
    }
  }
}
