import { connection } from 'next/server';
import { listOllamaModels, ollamaVersion } from '@/lib/ollama';
import { ollamaBaseURL } from '@/lib/providers';

export async function GET() {
  await connection();
  try {
    const [models, version] = await Promise.all([listOllamaModels(), ollamaVersion()]);
    return Response.json({ host: ollamaBaseURL(), version, models });
  } catch (e) {
    return Response.json({ host: ollamaBaseURL(), error: (e as Error).message, models: [] }, { status: 502 });
  }
}
