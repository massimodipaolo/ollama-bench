import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // loaded natively by Node (not bundled): the server-side Mermaid check shims Mermaid's own DOMPurify instance
  serverExternalPackages: ['mermaid', 'dompurify'],
  partialPrefetching: true,
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
