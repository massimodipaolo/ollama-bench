import 'server-only';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { getTest, isKnownTest } from '@/lib/tests/registry';
import { getLanguage } from '@/config/languages';
import type { CaseOutput, JudgeMaterial } from '@/lib/tests/types';

export type PromptMaterial =
  { ok: true; title: string; material: Omit<JudgeMaterial, 'response'>; note?: string } | { ok: false; status: number; error: string };

/**
 * What a case gave the model (session page "Prompt" overlay and its file links): the test's promptPreview when it
 * has one, else its judge material without the response. Inputs that depend on the run (RAG passages) come from the
 * first recorded result for the case; they are identical for every model in a session.
 */
export async function promptMaterial(sessionId: string, caseId: string): Promise<PromptMaterial> {
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  if (!isKnownTest(session.testId)) return { ok: false, status: 404, error: `Test ${session.testId} is no longer in the suite` };
  const test = getTest(session.testId);
  const lang = getLanguage(session.lang);
  const c = test.loadCases(lang.code).find((x) => x.id === caseId);
  if (!c) return { ok: false, status: 404, error: `Case ${caseId} is not in the current fixtures` };

  const cr = db
    .select({ cr: schema.caseResults })
    .from(schema.caseResults)
    .innerJoin(schema.runs, eq(schema.caseResults.runId, schema.runs.id))
    .where(and(eq(schema.runs.sessionId, sessionId), eq(schema.caseResults.caseId, caseId)))
    .orderBy(schema.runs.id)
    .get()?.cr;
  const out = { output: cr?.output ?? '', reasoning: cr?.reasoning ?? undefined, data: cr?.data ?? undefined } as CaseOutput;

  try {
    const material = test.promptPreview ? await test.promptPreview(c, lang, session.config.extra ?? {}) : test.judgeMaterial(c, out, lang);
    return { ok: true, title: c.title, material };
  } catch {
    // material that needs run data (tool traces, retrieved passages) before any result exists: show the case itself
    return {
      ok: true,
      title: c.title,
      material: { task: c.title, input: JSON.stringify(c, null, 2) },
      note: 'No result recorded for this case yet: showing the case definition.',
    };
  }
}
