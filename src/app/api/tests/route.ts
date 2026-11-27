import { connection } from 'next/server';
import { listTests } from '@/lib/tests/registry';
import { judges } from '@/lib/providers';
import { LANGUAGES } from '@/config/languages';
import { CAPABILITIES } from '@/config/capabilities';
import { sdkVersions } from '@/lib/versions';

export async function GET() {
  await connection();
  return Response.json({
    tests: await listTests(),
    // pnpm bench --capabilities expands these, so it follows the app it talks to, not the local checkout
    capabilities: CAPABILITIES.map(({ id, label, tests }) => ({ id, label, tests })),
    languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
    judges: judges().map(({ id, label, modelId }) => ({ id, label, modelId })),
    sdk: sdkVersions(),
  });
}
