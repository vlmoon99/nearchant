// Privacy rule: a seller keeps seeing the buyer's contact while the order is open and for a while after it closes
// (questions about delivery, returns), then it is hidden.

export const DAY_MS = 86_400_000;

export interface VisibilityOptions {
  /** How long the contact stays visible after the order closes. Default 90 days. */
  keepMs?: number;
  /** Order states that count as closed. Default: released (paid out) and refunded. */
  closedStates?: readonly string[];
  /** Current time in ms (for tests). Default Date.now(). */
  now?: number;
}

/**
 * True while the seller may see the buyer's contact: the order is open, or it closed less than `keepMs` ago.
 * `updatedAt` is when the order last changed state (for a closed order: when it closed). An unreadable date hides it.
 */
export function contactVisible(order: { state: string; updatedAt: string | number | Date }, opts: VisibilityOptions = {}): boolean {
  const closed = opts.closedStates ?? ["released", "refunded"];
  if (!closed.includes(order.state)) return true;
  const t = new Date(order.updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return (opts.now ?? Date.now()) - t < (opts.keepMs ?? 90 * DAY_MS);
}
