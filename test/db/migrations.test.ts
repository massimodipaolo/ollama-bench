// The database a fresh install gets: every migration applies, in order, on an empty file.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_PATH, getDb } from '@/db';

const client = () => (getDb() as unknown as { $client: import('better-sqlite3').Database }).$client;
const columns = (table: string) =>
  (client().prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);

describe('migrations on an empty database', () => {
  it('uses the temporary database of this test file, never the real one', () => {
    expect(DB_PATH).toBe(process.env.BENCH_DB_PATH);
    expect(DB_PATH).toContain('ollama-bench-test-');
  });

  it('applies every migration in drizzle/', () => {
    const files = readdirSync(join(process.cwd(), 'drizzle')).filter((f) => f.endsWith('.sql'));
    const applied = client().prepare('select count(*) as n from __drizzle_migrations').get() as { n: number };
    expect(applied.n).toBe(files.length);
  });

  it('has the tables and recent columns the app reads', () => {
    expect(columns('sessions')).toEqual(expect.arrayContaining(['id', 'test_id', 'status', 'finished_at', 'batch_id', 'instance_id']));
    expect(columns('runs')).toEqual(expect.arrayContaining(['started_at', 'finished_at', 'exec_ms', 'avg_tok_per_sec']));
    expect(columns('case_results')).toEqual(expect.arrayContaining(['latency_ms', 'ttft_ms', 'exec_ms']));
    expect(columns('judgments')).toContain('without_attachments');
  });

  it('enforces foreign keys and uses WAL', () => {
    expect(client().pragma('foreign_keys', { simple: true })).toBe(1);
    expect(client().pragma('journal_mode', { simple: true })).toBe('wal');
  });
});
