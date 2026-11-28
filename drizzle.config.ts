import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.BENCH_DB_PATH ?? path.join(os.homedir(), '.ollama-bench', 'bench.db') },
});
