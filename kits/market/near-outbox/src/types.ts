export type OutboxState = "pending" | "sending" | "done" | "failed";

/** One side effect to perform once: a NEAR transaction, an email, a webhook… */
export interface OutboxItem {
  id: number;
  /** Idempotency key: the same key is never queued twice. */
  key: string;
  /** Which handler runs it. */
  kind: string;
  payload: unknown;
  state: OutboxState;
  /** Tries started so far (incremented when a worker claims the item). */
  attempts: number;
  lastError: string | null;
  /** What the handler returned, when done. */
  result: unknown;
  /** Not claimed before this time (backoff). */
  nextAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Storage behind the outbox. `claim` must be atomic: two workers never get the same item. */
export interface OutboxStore {
  /** Inserts a pending item due at `now`. False if the key already exists (nothing changes). */
  insert(key: string, kind: string, payload: unknown, now: Date): Promise<boolean>;
  get(key: string): Promise<OutboxItem | null>;
  /** The newest item whose key is `base` or starts with `base:`. */
  latest(base: string): Promise<OutboxItem | null>;
  /**
   * Takes the oldest due item and marks it `sending` with attempts + 1. Due = pending with nextAt <= now, or
   * `sending` with updatedAt older than `staleBefore` (a worker that crashed mid-send).
   */
  claim(now: Date, staleBefore: Date): Promise<OutboxItem | null>;
  /** Records the outcome of a claimed item. */
  finish(id: number, patch: { state: OutboxState; lastError: string | null; result?: unknown; nextAt: Date }, now: Date): Promise<void>;
}

/** What a UI needs to show an action live. */
export interface ActionStatus {
  key: string;
  kind: string;
  state: OutboxState;
  attempts: number;
  error: string | null;
  /** When the action was queued (the user's tap), ISO. Count elapsed time from here, not from page load. */
  since: string;
  updatedAt: string;
}
