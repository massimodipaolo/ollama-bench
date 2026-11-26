/**
 * Re-judge from the CLI.
 *   pnpm rejudge <sessionId> [openai,google,anthropic]   whole session (optionally only some judges)
 *   pnpm rejudge --invalid [--dry-run]                    find degenerate stored verdicts (no criteria, leaked judge
 *                                                         scratchpad, flat mid-scale criteria, …) and re-ask only
 *                                                         those judges on those cases (a flat verdict with attached
 *                                                         files falls back to judging without them). Only
 *                                                         verdicts by the currently configured judge model are
 *                                                         repaired, so a session never mixes judge models; others
 *                                                         are listed with the env override that repairs them.
 */
import { eq, isNotNull } from 'drizzle-orm';
import { rejudgeSession } from '../src/lib/runner';
import { flatVerdict, invalidVerdict } from '../src/lib/judges';
import { getTest } from '../src/lib/tests/registry';
import { getDb, schema } from '../src/db';
import { judges } from '../src/lib/providers';

const args = process.argv.slice(2);
const db = getDb();

if (args[0] === '--invalid') {
  const dry = args.includes('--dry-run');
  const rows = db
    .select({ j: schema.judgments, cr: schema.caseResults, run: schema.runs, s: schema.sessions })
    .from(schema.judgments)
    .innerJoin(schema.caseResults, eq(schema.judgments.caseResultId, schema.caseResults.id))
    .innerJoin(schema.runs, eq(schema.caseResults.runId, schema.runs.id))
    .innerJoin(schema.sessions, eq(schema.runs.sessionId, schema.sessions.id))
    .where(isNotNull(schema.judgments.score))
    .all();
  // session → judge → case result ids
  const todo = new Map<string, Map<string, number[]>>();
  const current = new Map<string, string>(judges().map((x) => [x.id, x.modelId]));
  const otherModel = new Map<string, number>();
  for (const { j, cr, s } of rows) {
    const why =
      invalidVerdict({ rationale: j.rationale ?? '', criteria: j.criteria ?? [] }, getTest(s.testId).rubric) ??
      (!j.withoutAttachments && flatVerdict({ criteria: j.criteria ?? [] })
        ? 'flat verdict (every criterion the same mid-scale score)'
        : null);
    if (!why) continue;
    const label = `${s.id} · ${s.testId} · ${cr.caseId} · ${j.judge} ${j.judgeModel} (score ${j.score}) → ${why}`;
    if (current.get(j.judge) !== j.judgeModel) {
      console.log(`${label} · SKIPPED: ${j.judge} is now ${current.get(j.judge) ?? 'not configured'}`);
      const k = `${j.judge.toUpperCase()}_MODEL=${j.judgeModel}`;
      otherModel.set(k, (otherModel.get(k) ?? 0) + 1);
      continue;
    }
    console.log(label);
    const byJudge = todo.get(s.id) ?? new Map<string, number[]>();
    byJudge.set(j.judge, [...(byJudge.get(j.judge) ?? []), cr.id]);
    todo.set(s.id, byJudge);
  }
  if (!todo.size) console.log('No invalid verdicts by the configured judge models.');
  for (const [k, n] of otherModel) console.log(`${n} verdict(s) by another model: repair with  ${k} pnpm rejudge --invalid`);
  if (!dry) {
    for (const [sessionId, byJudge] of todo) {
      for (const [judge, ids] of byJudge) await rejudgeSession(sessionId, [judge], ids);
      const runs = db.select().from(schema.runs).where(eq(schema.runs.sessionId, sessionId)).all();
      for (const r of runs) console.log(`  ${sessionId} run ${r.id}: judges ${JSON.stringify(r.judgeScores)} avg ${r.judgeAvg}`);
    }
  }
} else {
  const [id, judges] = args;
  if (!id) throw new Error('usage: pnpm rejudge <sessionId> [openai,google,anthropic] | pnpm rejudge --invalid [--dry-run]');
  await rejudgeSession(id, judges?.split(','));
  for (const r of db.select().from(schema.runs).where(eq(schema.runs.sessionId, id)).all())
    console.log(r.id, r.judgeScores, 'avg', r.judgeAvg);
}
