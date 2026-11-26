import { connection } from 'next/server';
import { listTests } from '@/lib/tests/registry';
import { judges } from '@/lib/providers';
import { LANGUAGES } from '@/config/languages';
import { sdkVersions } from '@/lib/versions';

export async function GET() {
  await connection();
  return Response.json({
    tests: await listTests(),
    languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
    judges: judges().map(({ id, label, modelId }) => ({ id, label, modelId })),
    sdk: sdkVersions(),
  });
}
