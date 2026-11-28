/**
 * One Node major for the host and the container: .nvmrc (nvm, fnm…) and the Dockerfile's NODE_VERSION both name the
 * major only, so each picks up the latest patch releases (security fixes) by itself. Only the major must agree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

describe('Node version', () => {
  const nvmrc = read('.nvmrc').trim();
  const docker = /^ARG NODE_VERSION=(\S+)$/m.exec(read('Dockerfile'))?.[1];

  it('.nvmrc and the Dockerfile name the same major, and only the major', () => {
    expect(nvmrc).toMatch(/^\d+$/);
    expect(docker).toBe(nvmrc);
  });

  it('every stage of the Dockerfile uses that version', () => {
    const froms = [...read('Dockerfile').matchAll(/^FROM node:(\S+)/gm)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toBe('${NODE_VERSION}-alpine');
  });

  it('the Node running the tests is that major', () => {
    expect(process.versions.node.split('.')[0]).toBe(nvmrc);
  });
});
