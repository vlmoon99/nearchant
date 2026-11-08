// Postgres store with plain SQL. Pass a `pg` Pool (or anything with the same `query`). Claims use
// SELECT … FOR UPDATE SKIP LOCKED, so any number of workers on any number of machines never take the same row.
import type { OutboxItem, OutboxState, OutboxStore } from "./types.js";

/** The part of `pg.Pool` / `pg.Client` this store uses. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const ident = (t: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(t)) throw new Error(`bad table name "${t}" (lowercase letters, digits, _)`);
  return t;
};

/** Creates the table and its indexes if missing. Safe to run on every start. */
export async function migrateOutbox(db: Queryable, table = "outbox"): Promise<void> {
  const t = ident(table);
  await db.query(`CREATE TABLE IF NOT EXISTS ${t} (
    id          bigserial PRIMARY KEY,
    key         text NOT NULL,
    kind        text NOT NULL,
    payload     jsonb NOT NULL,
    state       text NOT NULL DEFAULT 'pending',
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    result      jsonb,
    next_at     timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_key ON ${t} (key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${t}_due ON ${t} (state, next_at)`);
}

const row = (r: any): OutboxItem => ({
  id: Number(r.id), key: r.key, kind: r.kind, payload: r.payload, state: r.state as OutboxState, attempts: r.attempts,
  lastError: r.last_error, result: r.result, nextAt: new Date(r.next_at), createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
});
/** Escapes % _ \ for LIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PostgresStore implements OutboxStore {
  private readonly t: string;
  constructor(private readonly db: Queryable, opts: { table?: string } = {}) { this.t = ident(opts.table ?? "outbox"); }

  async insert(key: string, kind: string, payload: unknown, now: Date): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO ${this.t} (key, kind, payload, next_at, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4, $4) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [key, kind, JSON.stringify(payload ?? null), now]);
    return r.rows.length === 1;
  }

  async get(key: string): Promise<OutboxItem | null> {
    const r = await this.db.query(`SELECT * FROM ${this.t} WHERE key = $1`, [key]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async latest(base: string): Promise<OutboxItem | null> {
    const r = await this.db.query(`SELECT * FROM ${this.t} WHERE key = $1 OR key LIKE $2 ESCAPE '\\' ORDER BY id DESC LIMIT 1`, [base, `${likeEscape(base)}:%`]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async claim(now: Date, staleBefore: Date): Promise<OutboxItem | null> {
    // One statement = one transaction: the row lock from the subquery is held until the UPDATE commits.
    const r = await this.db.query(
      `UPDATE ${this.t} SET state = 'sending', attempts = attempts + 1, updated_at = $1
       WHERE id = (
         SELECT id FROM ${this.t}
         WHERE (state = 'pending' AND next_at <= $1) OR (state = 'sending' AND updated_at < $2)
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`, [now, staleBefore]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async finish(id: number, patch: { state: OutboxState; lastError: string | null; result?: unknown; nextAt: Date }, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE ${this.t} SET state = $2, last_error = $3, next_at = $4, updated_at = $5, result = COALESCE($6::jsonb, result) WHERE id = $1`,
      [id, patch.state, patch.lastError, patch.nextAt, now, patch.result === undefined ? null : JSON.stringify(patch.result)]);
  }
}
