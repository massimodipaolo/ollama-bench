/* Connectivity smoke test: one Ollama call + one call per judge provider.
   Run: pnpm tsx --env-file=.env scripts/smoke.ts */
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { ollama, judges } from '../src/lib/providers';

async function main() {
  const t0 = Date.now();
  const r = await generateText({
    model: ollama('granite4.2:3b', { think: false }),
    prompt: 'Reply with exactly: pong',
    temperature: 0,
  });
  console.log('ollama:', JSON.stringify(r.text), Date.now() - t0, 'ms');
  console.log('usage:', r.usage.inputTokens, r.usage.outputTokens);
  console.log('perf:', r.steps[0]?.performance);
  console.log('meta:', r.providerMetadata);

  const schema = z.object({ score: z.number().min(0).max(10), rationale: z.string() });
  await Promise.all(
    judges().map(async (j) => {
      const t = Date.now();
      try {
        const { output } = await generateText({
          model: j.model,
          output: Output.object({ schema }),
          abortSignal: AbortSignal.timeout(90_000),
          prompt: 'Score this answer to "2+2?" from 0 to 10: "4". One sentence rationale.',
        });
        console.log(`judge ${j.id} (${j.modelId}):`, output, Date.now() - t, 'ms');
      } catch (e) {
        console.log(`judge ${j.id} FAILED:`, (e as Error).message);
      }
    }),
  );
}

main();
