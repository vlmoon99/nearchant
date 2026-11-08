import type { OutboxItem, OutboxState, OutboxStore } from "./types.js";

/** In-process store for tests, demos and single-process apps (lost on restart). Claims are atomic within the process. */
export class MemoryStore implements OutboxStore {
  private rows: OutboxItem[] = [];
  private nextId = 1;

  async insert(key: string, kind: string, payload: unknown, now: Date): Promise<boolean> {
    if (this.rows.some((r) => r.key === key)) return false;
    // structuredClone: the stored payload can't be changed by the caller afterwards, like a database row.
    this.rows.push({ id: this.nextId++, key, kind, payload: structuredClone(payload), state: "pending", attempts: 0, lastError: null, result: null, nextAt: now, createdAt: now, updatedAt: now });
    return true;
  }

  async get(key: string): Promise<OutboxItem | null> {
    const r = this.rows.find((x) => x.key === key);
    return r ? { ...r } : null;
  }

  async latest(base: string): Promise<OutboxItem | null> {
    let best: OutboxItem | null = null;
    for (const r of this.rows) if ((r.key === base || r.key.startsWith(`${base}:`)) && (!best || r.id > best.id)) best = r;
    return best ? { ...best } : null;
  }

  async claim(now: Date, staleBefore: Date): Promise<OutboxItem | null> {
    // No await between find and update: two concurrent claims in one process can't take the same row.
    const r = this.rows.find((x) => (x.state === "pending" && x.nextAt <= now) || (x.state === "sending" && x.updatedAt < staleBefore));
    if (!r) return null;
    r.state = "sending"; r.attempts++; r.updatedAt = now;
    return { ...r };
  }

  async finish(id: number, patch: { state: OutboxState; lastError: string | null; result?: unknown; nextAt: Date }, now: Date): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    r.state = patch.state; r.lastError = patch.lastError; r.nextAt = patch.nextAt; r.updatedAt = now;
    if (patch.result !== undefined) r.result = patch.result;
  }

  /** All rows, oldest first (for tests and admin pages). */
  all(): OutboxItem[] { return this.rows.map((r) => ({ ...r })); }
}
