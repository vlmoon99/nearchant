import postgres from "postgres";
import { connect, runMigrations, type Connection } from "../src/index.js";

/** Admin URL of the dev Postgres (deploy/local/compose.yaml). */
export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://nearchant:nearchant-dev@127.0.0.1:55432/nearchant";

/** A fresh, migrated database for one test file; dropped by `drop()`. */
export async function freshDb(): Promise<Connection & { drop: () => Promise<void> }> {
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const conn = connect(url, { max: 4 });
  await runMigrations(conn.db, conn.sql);
  return {
    ...conn,
    drop: async () => {
      await conn.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
