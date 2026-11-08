// npx tsx example.ts   — queue a "NEAR transaction" whose RPC fails twice, watch the worker retry it, and follow
// it the way a page would. Uses the in-memory store; swap in PostgresStore for real use.
import { MemoryStore, Outbox, exponentialBackoff, followAction } from "./src/index.js";

const outbox = new Outbox(new MemoryStore());
let calls = 0;
const handlers = {
  // A real handler would check the chain first (already delivered? return) and then sign the call.
  "order.mark_delivered": async (p: { orderId: string }, ctx: { attempt: number }) => {
    calls++;
    console.log(`  handler: try ${ctx.attempt} for ${p.orderId}`);
    if (calls <= 2) throw new Error(calls === 1 ? "request to rpc failed, reason: connect ETIMEDOUT" : "Server error 503");
    return { txHash: "8x…demo" };
  },
};

await outbox.enqueue("deliver:o-42", "order.mark_delivered", { orderId: "o-42" });
console.log("queued twice?", await outbox.enqueue("deliver:o-42", "order.mark_delivered", { orderId: "o-42" }) ? "yes (bug)" : "no — same key, ignored");

const stop = new AbortController();
const worker = outbox.runWorker({ handlers, pollMs: 50, backoff: exponentialBackoff({ baseMs: 300 }), signal: stop.signal, log: (l) => console.log(`  worker: ${l}`) });

const final = await followAction(() => outbox.status("deliver:o-42"), (u) => {
  if (u.phase === "done") console.log(`page: done ✓ after ${u.elapsed}`);
  else if (u.phase === "retrying") console.log(`page: NEAR didn't take it yet, trying again (try ${(u.status?.attempts ?? 0) + 1}) — ${u.why}`);
  else console.log(`page: ${u.phase}… ${u.elapsed}`);
}, { intervalMs: 200 });

stop.abort();
await worker;
console.log("final:", final, await outbox.get("deliver:o-42").then((r) => ({ state: r?.state, attempts: r?.attempts, result: r?.result })));
