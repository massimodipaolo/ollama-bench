import type { NextConfig } from 'next';
import { readInstalledVersions } from './src/lib/sdk-versions';

const nextConfig: NextConfig = {
  // the SDK versions this build compiles in, recorded with every session (src/lib/versions.ts): the standalone
  // server can't read them from node_modules, where Turbopack leaves no package.json for bundled libraries
  env: { BENCH_BUILD_SDK_VERSIONS: JSON.stringify(readInstalledVersions(process.cwd())) },
  /* config options here */
  cacheComponents: true,
  // loaded natively by Node (not bundled): the server-side Mermaid check shims Mermaid's own DOMPurify instance
  serverExternalPackages: ['mermaid', 'dompurify'],
  partialPrefetching: true,
  // .next/standalone: a minimal server.js with only the traced node_modules (the Docker image ships this; `next start`
  // still works locally, with a warning). The MCP test's server (scripts/mcp/benchmark-server.mjs) is spawned as its
  // own Node process, so its imports aren't traced: the Dockerfile bundles it into the standalone output instead.
  output: 'standalone',
  // files the server reads by path (process.cwd()), which tracing can't see
  outputFileTracingIncludes: {
    '/**': [
      './drizzle/**', // migrations, applied when the database opens
      './fixtures/**', // test cases and references
      './.data/files/**', // the sample source files the tests read
    ],
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
