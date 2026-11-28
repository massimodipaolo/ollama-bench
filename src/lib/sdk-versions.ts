/**
 * Reading the installed versions of the SDK stack from node_modules. No 'server-only' guard: next.config.ts imports
 * it too, to record the versions at build time (see versions.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Libraries whose versions are recorded with every session (the benchmark also tests the SDK stack itself). */
export const TRACKED_PACKAGES = [
  'ai',
  'ai-sdk-ollama',
  'ollama',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/anthropic',
  '@ai-sdk/cohere',
  '@ai-sdk/mcp',
];

function readVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Installed versions, read from `<root>/node_modules` (pnpm symlinks direct dependencies at the top level).
 * `ollama` (the JS client) is a dependency of ai-sdk-ollama: resolved next to it in pnpm's store.
 */
export function readInstalledVersions(root: string): Record<string, string> {
  const nm = path.join(root, 'node_modules');
  const out: Record<string, string> = {};
  for (const pkg of TRACKED_PACKAGES) {
    let v = readVersion(path.join(nm, ...pkg.split('/')));
    if (!v && pkg === 'ollama') {
      try {
        v = readVersion(path.join(fs.realpathSync(path.join(nm, 'ai-sdk-ollama')), '..', 'ollama'));
      } catch {}
    }
    if (v) out[pkg] = v;
  }
  return out;
}
