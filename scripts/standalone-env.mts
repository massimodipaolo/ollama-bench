/**
 * Runs after `next build` (package.json "build"): deletes the .env files `next build` copied into the standalone
 * output (.next/standalone/.env, .env.local, …). Next copies every env file it loads there, API keys included, and
 * nothing reads that copy: `pnpm start` runs `next start` from the project root, and the Docker image gets its
 * settings at run time (see the Dockerfile). A copy in build output is one `git add -f`, upload or image away from
 * leaking, and `pnpm security:secrets` reports it.
 *
 *   tsx scripts/standalone-env.mts      # from the project root (pnpm build does it)
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '.next', 'standalone');
const copies = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('.env')) : [];
for (const f of copies) rmSync(join(dir, f), { force: true });
if (copies.length) console.log(`standalone output: removed the env file copies ${copies.join(', ')} (settings come at run time)`);
