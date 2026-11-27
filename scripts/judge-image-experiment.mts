/**
 * Calibration experiment: does the Google judge's flat 7 on image cases depend on image format, size or the
 * position of the image in the message? Judges one stored, known-good answer N times per variant.
 *   pnpm tsx --conditions=react-server --env-file=.env scripts/judge-image-experiment.mts [reps] [variant-name-filter]
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { FilePart } from 'ai';
import { getDb, schema } from '../src/db';
import { judges } from '../src/lib/providers';
import { judgeOnce } from '../src/lib/judges';
import { getTest } from '../src/lib/tests/registry';
import { getLanguage } from '../src/config/languages';

const require = createRequire(import.meta.url);
const sharpDir = path.join(process.cwd(), 'node_modules/.pnpm/sharp@0.35.5_@types+node@20.19.43/node_modules/sharp');
// sharp is only a transitive dependency (via next), so it is loaded by path
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp = require(sharpDir) as (input: Buffer) => any;

const REPS = Number(process.argv[2] ?? 4);
const FILTER = process.argv[3]?.toLowerCase() ?? null;
type Variant = { attachments: FilePart[]; first?: boolean; google?: Record<string, unknown> };
const CASES = ['infographic-steps', 'pdf-reading-order'];
const db = getDb();
const test = getTest('image-recognition');
const lang = getLanguage('en');
const google = judges().find((j) => j.id === 'google');
if (!google) throw new Error('Google judge not configured');
console.log(`judge: ${google.modelId} · reps: ${REPS}`);

async function convert(p: FilePart, kind: 'png' | 'png2x'): Promise<FilePart> {
  const img = sharp(Buffer.from(p.data as Uint8Array));
  const meta = await img.metadata();
  const out = kind === 'png2x' ? img.resize({ width: (meta.width ?? 0) * 2, kernel: 'lanczos3' }).png() : img.png();
  return { ...p, data: new Uint8Array(await out.toBuffer()), mediaType: 'image/png', filename: p.filename?.replace(/\.\w+$/, '.png') };
}

for (const caseId of CASES) {
  const c = test.loadCases('en').find((x) => x.id === caseId)!;
  // most recent answer to this case that the other judges rated >= 9.5 (a known-good answer)
  const crs = db
    .select({ cr: schema.caseResults })
    .from(schema.caseResults)
    .innerJoin(schema.runs, eq(schema.caseResults.runId, schema.runs.id))
    .innerJoin(schema.sessions, eq(schema.runs.sessionId, schema.sessions.id))
    .where(and(eq(schema.sessions.testId, 'image-recognition'), eq(schema.sessions.lang, 'en'), eq(schema.caseResults.caseId, caseId)))
    .orderBy(desc(schema.caseResults.id))
    .all();
  const good = crs.find(({ cr }) => {
    const js = db.select().from(schema.judgments).where(eq(schema.judgments.caseResultId, cr.id)).all();
    const others = js.filter((j) => j.judge !== 'google' && j.score != null);
    return others.length >= 2 && others.every((j) => (j.score ?? 0) >= 9.5);
  });
  if (!good) {
    console.log(`${caseId}: no known-good answer stored, skipped`);
    continue;
  }
  const base = test.judgeMaterial(c, { output: good.cr.output ?? '' } as never, lang);
  const att = base.attachments ?? [];
  const variants: [string, () => Promise<Variant>][] = [
    ['original, after text (current)', async () => ({ attachments: att })],
    ['PNG same size, after text', async () => ({ attachments: await Promise.all(att.map((p) => convert(p, 'png'))) })],
    ['PNG 2x upscaled, after text', async () => ({ attachments: await Promise.all(att.map((p) => convert(p, 'png2x'))) })],
    ['original, BEFORE text', async () => ({ attachments: att, first: true })],
    ['no image', async () => ({ attachments: [] })],
    ['mediaResolution HIGH', async () => ({ attachments: att, google: { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } })],
    ['thinkingLevel high', async () => ({ attachments: att, google: { thinkingConfig: { thinkingLevel: 'high' } } })],
    [
      'mediaResolution HIGH + thinking high',
      async () => ({ attachments: att, google: { mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingLevel: 'high' } } }),
    ],
  ];
  console.log(`\n${caseId} (case result ${good.cr.id}, ${att.map((a) => `${a.filename} ${a.mediaType}`).join(', ')})`);
  for (const [name, make] of variants) {
    if (FILTER && !name.toLowerCase().includes(FILTER)) continue;
    const v = await make();
    const judge = v.google ? { ...google, providerOptions: { google: v.google } as never } : google;
    const scores = await Promise.all(
      Array.from({ length: REPS }, () =>
        judgeOnce(judge, test.rubric, { ...base, attachments: v.attachments }, lang, 'case', { attachmentsFirst: v.first })
          .then((r) => {
            const crit = new Set(r.criteria.map((x) => x.score));
            return `${r.score}${crit.size === 1 && r.score < 10 ? '*' : ''}`;
          })
          .catch((e) => `err(${String(e).slice(0, 40)})`),
      ),
    );
    console.log(`  ${name.padEnd(38)} ${scores.join('  ')}`);
  }
}
console.log('\n* = every criterion has the same score (the "flat" pattern)');
