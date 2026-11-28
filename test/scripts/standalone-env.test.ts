/**
 * No API keys in the local build output. `next build` copies every .env file it loads into .next/standalone; `pnpm
 * build` deletes those copies (scripts/standalone-env.mts), as the Docker build already did. Found by `pnpm security`'s
 * tree secret scan: own secrets in .next/standalone/.env.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'standalone-env.mts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the script the way `pnpm build` does, from a project root of our own. */
function runIn(project: string) {
  return spawnSync(process.execPath, ['--import', tsx, script], { cwd: project, encoding: 'utf8' });
}

describe('pnpm build removes the env files next build copied into the standalone output', () => {
  it('deletes every .env* copy and leaves the server alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'standalone-env-'));
    const standalone = join(dir, '.next', 'standalone');
    mkdirSync(standalone, { recursive: true });
    for (const f of ['.env', '.env.local', '.env.production', 'server.js', 'package.json']) writeFileSync(join(standalone, f), 'x');

    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(standalone).sort()).toEqual(['package.json', 'server.js']);
  });

  it('does nothing without a standalone output', () => {
    dir = mkdtempSync(join(tmpdir(), 'standalone-env-'));
    const r = runIn(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(dir, '.next'))).toBe(false);
  });

  it('is part of the build script, after next build', () => {
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(scripts.build).toMatch(/^next build && tsx scripts\/standalone-env\.mts$/);
  });
});
