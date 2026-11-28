/**
 * No settings in the Docker image. `next build` copies every .env file it loads into the standalone output, which the
 * image ships: a .env given to the build (once a BuildKit secret mounted as /app/.env) ended up as /app/.env in the
 * image, API keys included. Settings come only at run time. These checks read the files; `pnpm security` scans the
 * built image itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const lines = (f: string) =>
  read(f)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

describe('the Docker image gets no settings at build time', () => {
  it('.dockerignore keeps every .env file out of the build context (only the example gets in)', () => {
    const ignore = lines('.dockerignore');
    expect(ignore).toContain('.env*');
    expect(ignore.filter((l) => l.startsWith('!.env'))).toEqual(['!.env.example']);
  });

  it('the Dockerfile mounts no secret and copies no .env', () => {
    const docker = lines('Dockerfile').join('\n');
    expect(docker).not.toMatch(/--mount=type=secret/);
    expect(docker).not.toMatch(/^(COPY|ADD)\b.*\.env(?!\.example)/m);
  });

  it('the build deletes any .env that next build copied into the standalone output', () => {
    expect(read('Dockerfile')).toMatch(/RUN pnpm build \\\s*\n\s*&& rm -f \.next\/standalone\/\.env\*/);
  });

  it('no build command passes a secret either (VS Code task, pnpm security --build)', () => {
    expect(read('.vscode/tasks.json')).not.toMatch(/--secret/);
    expect(read('scripts/security.mts')).not.toMatch(/'--secret'/);
  });
});
