// Runs only with PG_URL set (a throwaway database), e.g.
//   PG_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run test/postgres.test.ts
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Outbox, PostgresStore, migrateOutbox } from "../src/index.js";

const url = process.env.PG_URL;
const table = `outbox_test_${process.pid}`;

describe.skipIf(!url)("PostgresStore (PG_URL)", () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 10 }); await migrateOutbox(pool, table); await migrateOutbox(pool, table); });
  afterAll(async () => { await pool.query(`DROP TABLE IF EXISTS ${table}`); await pool.end(); });

  it("enqueue is idempotent, drain records results, latest handles LIKE characters", async () => {
    const ob = new Outbox(new PostgresStore(pool, { table }));
    expect(await ob.enqueue("ship:o_1", "x", { a: 1 })).toBe(true);
    expect(await ob.enqueue("ship:o_1", "x", { a: 2 })).toBe(false);
    await ob.enqueue("ship:oX1", "x", {}); // `_` must not match X
    expect((await ob.latest("ship:o_1"))!.payload).toEqual({ a: 1 });
    await ob.drain({ handlers: { x: async (p: { a?: number }) => ({ got: p.a ?? 0 }) } });
    expect(await ob.get("ship:o_1")).toMatchObject({ state: "done", attempts: 1, result: { got: 1 } });
    expect(await ob.enqueueAgain("ship:o_1", "x", { a: 3 })).toBe(true);
    expect((await ob.status("ship:o_1"))!.state).toBe("pending");
  });

  it("retries and fails after max attempts", async () => {
    const ob = new Outbox(new PostgresStore(pool, { table }));
    await ob.enqueue("fail:1", "bad", {});
    for (let i = 0; i < 3; i++) await ob.drain({ handlers: { x: async () => {}, bad: async () => { throw new Error("nope"); } }, maxAttempts: 2, backoff: () => 0 });
    expect(await ob.get("fail:1")).toMatchObject({ state: "failed", attempts: 2, lastError: "nope" });
  });

  it("SKIP LOCKED: concurrent workers on separate connections don't double-claim", async () => {
    const ob = new Outbox(new PostgresStore(pool, { table }));
    for (let i = 0; i < 40; i++) await ob.enqueue(`c:${i}`, "c", i);
    const runs = new Map<number, number>();
    const handlers = { x: async () => {}, bad: async () => {}, c: async (p: number) => { await new Promise((r) => setTimeout(r, 2)); runs.set(p, (runs.get(p) ?? 0) + 1); } };
    await Promise.all(Array.from({ length: 6 }, () => ob.drain({ handlers, limit: 100 })));
    expect(runs.size).toBe(40);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });
});
