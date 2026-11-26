import 'server-only';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from './schema';

/**
 * Outside the project on purpose: SQLite writes bench.db-wal/-shm on every write (and -shm even on reads), and the
 * Next.js dev server watches the project tree, so a DB inside it made any open page reload in a loop during runs.
 */
export const DB_PATH = process.env.BENCH_DB_PATH ?? path.join(os.homedir(), '.ollama-benchmark', 'bench.db');

type DB = BetterSQLite3Database<typeof schema>;
const g = globalThis as unknown as { __benchDb?: DB };

function open(): DB {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  return db;
}

/** Singleton (survives HMR). Migrations are applied on first open. */
export function getDb(): DB {
  return (g.__benchDb ??= open());
}

export { schema };
