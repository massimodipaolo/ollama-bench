/**
 * src/lib/docker.ts without Docker: where there is no docker CLI (the app in its own container), the error says why
 * and what to do, instead of a bare "spawn docker ENOENT".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { docker } from '@/lib/docker';

const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
});

describe('docker()', () => {
  it('no docker CLI: a failed result explaining that the test needs the app on the host', async () => {
    process.env.PATH = ''; // nothing to find
    const r = await docker(['version'], { timeoutMs: 10_000 });
    expect(r.code).toBeNull();
    expect(r.out).toMatch(/docker CLI not found.*run it with the app on the host/);
  });
});
