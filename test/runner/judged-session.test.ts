/**
 * A whole session with judges: the model on the fake Ollama, the judges scripted (test/helpers/judges.ts). Judging
 * runs alongside the generations, then the session reports "judging", aggregates per-judge means and their average,
 * and ends.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Judge } from '@/lib/providers';
import type { SessionEvent } from '@/lib/runner/events';
import { startFakeOllama } from '../helpers/fake-ollama';
import { fakeJudge, verdictFor } from '../helpers/judges';
import { fakeModel, sessionFinished } from '../helpers/sessions';

const configured = vi.hoisted(() => ({ judges: [] as Judge[] }));
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers')>()),
  judges: () => configured.judges,
}));

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { startSession } = await import('@/lib/runner');
const { getLive } = await import('@/lib/runner/events');
const { getDb, schema } = await import('@/db');
const { getTest } = await import('@/lib/tests/registry');

afterAll(() => ollama.close());

describe('a judged session', () => {
  it('every judge scores every case blind; the run gets per-judge means and their average', async () => {
    ollama.routes['/api/tags'] = () => ({ models: [fakeModel('alpha:7b')] });
    const test = getTest('text-generation');
    const quick = test.loadCases('en').filter((c) => c.quick).length;
    const openai = fakeJudge(
      'openai',
      Array.from({ length: quick }, () => verdictFor(test.rubric, 8)),
    );
    const anthropic = fakeJudge(
      'anthropic',
      Array.from({ length: quick }, () => verdictFor(test.rubric, 6)),
    );
    configured.judges = [openai.judge, anthropic.judge];

    const id = await startSession({
      testId: 'text-generation',
      lang: 'en',
      models: ['alpha:7b'],
      config: { judges: ['openai', 'anthropic'] },
    });
    const events: SessionEvent[] = [];
    getLive(id)!.listeners.add((e: SessionEvent) => events.push(e));
    const session = await sessionFinished(id);

    expect(session.status).toBe('done');
    const db = getDb();
    const run = db.select().from(schema.runs).where(eq(schema.runs.sessionId, id)).get()!;
    expect(run.judgeScores).toEqual({ openai: 8, anthropic: 6 });
    expect(run.judgeAvg).toBe(7);
    const crs = db.select({ id: schema.caseResults.id }).from(schema.caseResults).where(eq(schema.caseResults.runId, run.id)).all();
    const js = db
      .select()
      .from(schema.judgments)
      .where(
        inArray(
          schema.judgments.caseResultId,
          crs.map((c) => c.id),
        ),
      )
      .all();
    expect(js).toHaveLength(quick * 2);

    // blind: the judges never see the model name
    for (const p of [...openai.prompts, ...anthropic.prompts]) expect(JSON.stringify(p)).not.toContain('alpha');
    expect(events.filter((e) => e.type === 'judgment')).toHaveLength(quick * 2);
    expect(events).toContainEqual({ type: 'session', status: 'judging' });
    expect(events.at(-1)).toEqual({ type: 'session-end', status: 'done' });
  });
});
