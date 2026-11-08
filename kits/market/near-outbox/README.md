# NEAR outbox

Send NEAR transactions (or any side effect — emails, webhooks, market submissions) once per key: queue it in your
database, let a worker send it with retries and backoff, and show the user its progress live until NEAR has it.

## Copy it

```sh
cp -r kits/market/near-outbox ./src/near-outbox
npm i pg          # only for PostgresStore; MemoryStore needs nothing
```

```ts
import { Outbox, PostgresStore, migrateOutbox, followAction, explainNearError } from "./near-outbox/src/index.js";
```

## Use it

```ts
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrateOutbox(pool);                       // CREATE TABLE IF NOT EXISTS outbox …
const outbox = new Outbox(new PostgresStore(pool));

// API: the seller taps "Mark shipped". Record the intent; don't call NEAR inside the request.
app.post("/orders/:id/ship", async (c) => {
  await outbox.enqueueAgain(`ship:${id}`, "order.ship", { orderId: id });   // no-op if one is already on its way
  return c.json({ ok: true });
});
app.get("/orders/:id/action", async (c) => c.json(await outbox.current([`ship:${id}`, `refund:${id}`])));

// Worker process (any number of them):
await outbox.runWorker({
  handlers: {
    "order.ship": async ({ orderId }, { signal }) => {
      const o = await viewOrder(orderId, { signal });              // idempotent: check the chain first
      if (o.status !== "Delivered") await account.functionCall({ contractId, methodName: "mark_delivered", args: { order_id: orderId } });
    },
  },
  maxAttempts: 8,
});

// Browser: show it live (no DOM inside — render the updates yourself)
await followAction(() => fetch(`/orders/${id}/action`).then((r) => r.json()), (u) => {
  bar.textContent = u.phase === "done" ? "Marked shipped ✓"
    : u.phase === "failed" ? `It didn't go through: ${u.why}`
    : `Recording on NEAR… ${u.elapsed}${u.phase === "retrying" ? " — trying again" : ""}`;
});
```

`npx tsx example.ts` runs a flaky fake handler through the in-memory store and prints every try.

## Options

| Where | Option | Default | What it does |
| --- | --- | --- | --- |
| `new Outbox(store, o)` | `now` | `Date.now` | Clock (tests) |
| | `staleMs` | 5 min | A `sending` item untouched this long is claimed again (its worker died). Keep it above `timeoutMs` |
| `runWorker(o)` / `drain(o)` | `handlers` | — | `{ [kind]: (payload, { key, attempt, signal }) => Promise<result> }` |
| | `maxAttempts` | 8 | Then the item is `failed` |
| | `backoff` | `exponentialBackoff()` | `(failedTries) => ms`; default 2 s doubling to 10 min, ±20 % jitter |
| | `timeoutMs` | 120 s | Per handler call; its `signal` is aborted |
| | `limit` | 20 | Items per drain round |
| | `pollMs` | 1 s | Sleep when nothing is due (`runWorker` only) |
| | `signal` | — | Stop the worker |
| | `log` | — | Gets one line per try |
| `new PostgresStore(pool, o)` | `table` | `"outbox"` | Table name (also for `migrateOutbox(pool, table)`) |
| `followAction(fetch, onUpdate, o)` | `intervalMs` / `slowAfterMs` / `slowMs` | 2 s / 5 min / 10 s | Poll pace |
| | `maxMs` | 30 min | Then phase `timeout` |
| | `startedAt`, `signal`, `now`, `sleep` | | |
| `explainNearError(text, o)` | `payer`, `max` | `"The app's"`, 140 | Plain words for a NEAR error |

Other methods: `enqueue(key, kind, payload)` → `true` if new · `get(key)` · `latest(base)` · `status(base)` →
`{ key, kind, state, attempts, error, since, updatedAt }` · `current(bases)` → newest open action or `null`.

## How it works

```
 API request ──enqueue(key)──▶ outbox row: pending ──claim (FOR UPDATE SKIP LOCKED)──▶ sending ──handler ok──▶ done
                                   ▲                                                     │
                                   └──── error: attempts < max, next_at = now + backoff ─┘── attempts = max ──▶ failed
 UI ◀── status(base) / current(bases): state, attempts, last error, since (the tap)
```

- **Once per key.** `enqueue` is `INSERT … ON CONFLICT (key) DO NOTHING`. Pick keys from your domain
  (`deliver:<order>:r<revision>`), and enqueue in the same transaction as the business change if you can.
- **Repeatable actions.** `enqueueAgain(base)` uses `base` first, then `base:<ms>` once the last one is done or
  failed ("try again"); while one is pending/sending it does nothing, so double taps are harmless.
- **At-least-once.** A crash after NEAR accepted the call but before the row is marked done repeats the call (after
  `staleMs`). Handlers must check first: view the order on chain, keep a checkpoint, or use a contract method that
  is a no-op when repeated.
- **Live UI.** `since` is when the action was queued, so a page opened later still counts from the tap.
  `followAction` stops on done / `null` (nothing on its way), failed, 404, abort or `maxMs`, and ignores network blips.
- Rows are never deleted; prune `done` rows older than you need with one `DELETE`.

## Tested

52 Vitest tests (49 run by default, 3 more against Postgres with `PG_URL=postgres://…`): idempotent enqueue,
backoff timing on a fake clock (not due at 999 ms, due at 1000 ms, doubling), jitter bounds, `failed` after
`maxAttempts`, errors recorded and cut, missing handler, handler timeout aborts its signal, stale `sending`
reclaimed, `enqueueAgain` (base key, no-op while open, new key after done/failed, same-millisecond uniqueness),
`latest` prefix safety, `status`/`current`, five concurrent workers never running an item twice, `runWorker`
surviving store errors and stopping on abort, `followAction` phases and timing, `explainNearError` patterns.
The Postgres tests (idempotency, LIKE escaping, retries, 6 workers on separate connections with SKIP LOCKED) were run
against Postgres 16. Not tested: real NEAR calls (handlers are yours) and very large tables.

## Came from

Nearchant: `Outbox` in `packages/db/src/pg.ts`, drained by the worker (`apps/worker/src/main.ts`, `outbox_drain`,
handlers such as `deliver` in `apps/worker/src/deliver.ts` that sign `proofs.record` and `orders.mark_delivered`
with the seller's function-call keys). The gateway exposes an order's open action (`orders.action` in
`apps/gateway/src/main.ts`) and the seller app follows it live (`liveOrder`, `actionBar`, `nearSays` in
`apps/gateway/web/app.ts`).
