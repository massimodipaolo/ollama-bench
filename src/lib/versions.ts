import 'server-only';
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
 * Installed versions, read from node_modules (pnpm symlinks direct dependencies at the top level).
 * `ollama` (the JS client) is a dependency of ai-sdk-ollama: resolved next to it in pnpm's store.
 */
export function sdkVersions(): Record<string, string> {
  const nm = path.join(process.cwd(), 'node_modules');
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

/** Compact label for tables: "ai 7.0.183 · ai-sdk-ollama 4.6.3". */
export function sdkLabel(v: Record<string, string> | undefined): string {
  if (!v) return '';
  return ['ai', 'ai-sdk-ollama']
    .filter((k) => v[k])
    .map((k) => `${k} ${v[k]}`)
    .join(' · ');
}
