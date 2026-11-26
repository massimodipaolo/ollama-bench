import 'server-only';
import crypto from 'node:crypto';
import { generateText, Output, type FilePart } from 'ai';
import { z } from 'zod';
import { and, eq, isNotNull, desc } from 'drizzle-orm';
import { judges as configuredJudges, type Judge } from '@/lib/providers';
import { getDb, schema } from '@/db';
import type { JudgeMaterial, Rubric } from '@/lib/tests/types';
import type { LanguageConfig } from '@/config/languages';
import type { CriterionScore } from '@/db/schema';

/**
 * Field order matters: the judge writes its analysis first, then per-criterion scores, then the overall score,
 * so the numbers are conditioned on the reasoning (score-first made Gemini fall back to a flat 7 on flawless answers).
 */
function verdictSchema(rubric: Rubric) {
  const names = rubric.criteria.map((c) => c.name) as [string, ...string[]];
  return z.object({
    rationale: z.string().describe('2-4 sentences: list the concrete errors found (or state that there are none)'),
    criteria: z
      .array(
        z.object({
          // enum + min length: an empty or invented criteria list fails validation (and is retried)
          name: (names.length ? z.enum(names) : z.string()).describe('criterion name, exactly as listed'),
          comment: z.string().describe('one short sentence'),
          score: z.number().describe('0-10'),
        }),
      )
      .min(names.length)
      .describe('one entry per listed criterion'),
    score: z.number().describe('overall score 0-10 (decimals allowed), consistent with the rationale and criteria'),
  });
}

export interface Verdict {
  rationale: string;
  criteria: { name: string; comment: string; score: number }[];
  score: number;
}

/** A judge's own scratchpad leaking into the rationale ("Wait—no extra text outside JSON! …"). */
const SCRATCHPAD =
  /^\s*(wait\b|let me\b|okay,? (so|let)\b|hmm\b)|no (extra )?text outside (the )?json|output only (the )?json|here is the json/i;

/**
 * Why a verdict is unusable (null = fine). Degenerate verdicts (no criteria, leaked scratchpad) are retried and,
 * if they persist, recorded as judge errors (excluded from averages) instead of counting as a 0.
 */
export function invalidVerdict(v: Pick<Verdict, 'rationale' | 'criteria'>, rubric: Rubric): string | null {
  const names = new Set((v.criteria ?? []).map((c) => c.name));
  const missing = rubric.criteria.filter((c) => !names.has(c.name)).map((c) => c.name);
  if (missing.length) return `missing criteria: ${missing.join(', ')}`;
  const r = (v.rationale ?? '').trim();
  if (r.length < 20) return 'rationale missing or too short';
  if (SCRATCHPAD.test(r)) return 'judge scratchpad leaked into the rationale';
  return null;
}

/**
 * A "flat" verdict: every criterion gets the same mid-scale score. With an image attached, Gemini returns a flat 7
 * on answers it calls flawless in its own comments (format, size, image position, media resolution and thinking
 * level make no difference; without the image it scores 10). Across all stored verdicts, mid-scale flat verdicts
 * came only from that case; other judges' flat verdicts sit at the extremes (0-2 or 9.8+), which this ignores.
 */
export function flatVerdict(v: Pick<Verdict, 'criteria'>): boolean {
  const scores = (v.criteria ?? []).map((c) => c.score);
  return scores.length >= 3 && scores.every((s) => s === scores[0]) && scores[0] > 3 && scores[0] < 9;
}

/** Bump when the judge prompt/schema changes: part of the cache key. */
const JUDGE_VERSION = 'j3';

const SYSTEM = `You are an impartial expert evaluator in a blind benchmark of AI systems.
You see one task and one anonymous candidate response. You do not know which system produced it; do not guess.
Work in this order: first identify concrete errors (rationale), then score each criterion, then give the overall score.
Score strictly and consistently on a 0–10 scale:
10 = flawless, 8 = strong with minor issues, 6 = acceptable but clear flaws, 4 = major problems, 2 = mostly wrong, 0 = empty/irrelevant.
Scores must follow from the errors you found: if you found no errors, the score is 9–10; every point deducted must correspond to an error you named.
Use the reference (when given) as ground truth for facts, not as the only acceptable wording.
Cosmetic differences that do not change meaning (punctuation after list numbers, list markers, capitalization, spacing, date or number formatting, quoting style) are not errors, unless the task explicitly requires that exact format.
Ignore response length unless the task constrains it. Do not reward confident tone. Output only the requested JSON.`;

function buildPrompt(rubric: Rubric, m: JudgeMaterial, lang: LanguageConfig, responseLanguage: 'case' | 'source') {
  const langRule =
    responseLanguage === 'source'
      ? 'Expected response language: the same language as the source document (the instructions may be in another language; translating the content is an error).'
      : `Expected response language: ${lang.englishName}. Penalize responses in a different language under the relevant criterion.`;
  return `## Evaluation instructions
${rubric.instructions}
${langRule}
${
  m.attachments?.length
    ? `The original source file(s) given to the candidate are attached: use them to verify fidelity.
`
    : ''
}
## Criteria
${rubric.criteria.map((c) => `- ${c.name}: ${c.description}`).join('\n')}

## Task
${m.task}

## Input given to the candidate
<input>
${m.input}
</input>
${m.reference ? `\n## Reference (ground truth / expectations)\n<reference>\n${m.reference}\n</reference>\n` : ''}
## Candidate response
<response>
${m.response || '(empty response)'}
</response>`;
}

const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(n * 10) / 10));

export interface JudgeOutcome {
  judge: string;
  judgeModel: string;
  score: number | null;
  criteria?: CriterionScore[];
  rationale?: string;
  latencyMs?: number;
  cached: boolean;
  error?: string;
  /** re-asked without the attached files after a flat verdict (see flatVerdict) */
  withoutAttachments?: boolean;
}

/** One verdict from an arbitrary model, without persistence (for experiments and calibration checks). */
export async function judgeOnce(
  j: Judge,
  rubric: Rubric,
  material: JudgeMaterial,
  lang: LanguageConfig,
  responseLanguage: 'case' | 'source' = 'case',
  opts: { attachmentsFirst?: boolean } = {},
): Promise<Verdict> {
  return callJudge(j, buildPrompt(rubric, material, lang, responseLanguage), rubric, material.attachments ?? [], opts.attachmentsFirst);
}

/** Up to 3 attempts; API errors and degenerate verdicts are both retried. */
async function callJudge(
  j: Judge,
  prompt: string,
  rubric: Rubric,
  attachments: FilePart[] = [],
  attachmentsFirst = false,
): Promise<Verdict> {
  const text = { type: 'text' as const, text: prompt };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { output } = await generateText({
        model: j.model,
        system: SYSTEM,
        ...(attachments.length
          ? { messages: [{ role: 'user' as const, content: attachmentsFirst ? [...attachments, text] : [text, ...attachments] }] }
          : { prompt }),
        output: Output.object({ schema: verdictSchema(rubric) }),
        providerOptions: j.providerOptions,
        abortSignal: AbortSignal.timeout(120_000),
        maxRetries: 1,
      });
      const why = invalidVerdict(output as Verdict, rubric);
      if (!why) return output as Verdict;
      lastErr = new Error(`invalid verdict after ${attempt + 1} attempt(s): ${why}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Run every configured judge (in parallel) on one case result, persist each judgment, and return them.
 * Identical (rubric, judge model, material) triples are served from previous judgments.
 */
export async function judgeCaseResult(opts: {
  caseResultId: number;
  rubric: Rubric;
  material: JudgeMaterial;
  lang: LanguageConfig;
  responseLanguage?: 'case' | 'source';
  enabled: string[];
}): Promise<JudgeOutcome[]> {
  const db = getDb();
  const prompt = buildPrompt(opts.rubric, opts.material, opts.lang, opts.responseLanguage ?? 'case');
  const attachments = opts.material.attachments ?? [];
  const attHash = attachments
    .map((a) =>
      crypto
        .createHash('sha256')
        .update(a.data instanceof Uint8Array ? a.data : String(a.data))
        .digest('hex'),
    )
    .join(',');
  const active = configuredJudges().filter((j) => opts.enabled.includes(j.id));

  return Promise.all(
    active.map(async (j): Promise<JudgeOutcome> => {
      const cacheKey = crypto
        .createHash('sha256')
        .update(`${JUDGE_VERSION}|${opts.rubric.version}|${j.modelId}|${prompt}|${attHash}`)
        .digest('hex');
      const hit = db
        .select()
        .from(schema.judgments)
        .where(and(eq(schema.judgments.cacheKey, cacheKey), isNotNull(schema.judgments.score)))
        .orderBy(desc(schema.judgments.id))
        .get();
      // never reuse a degenerate cached verdict (e.g. stored before validation or the flat-verdict fallback existed)
      const reusable =
        hit &&
        !invalidVerdict({ rationale: hit.rationale ?? '', criteria: hit.criteria ?? [] }, opts.rubric) &&
        !(attachments.length && !hit.withoutAttachments && flatVerdict({ criteria: hit.criteria ?? [] }));
      if (hit && reusable) {
        db.insert(schema.judgments)
          .values({ ...hit, id: undefined, caseResultId: opts.caseResultId, cached: true, createdAt: Date.now() })
          .run();
        return {
          judge: j.id,
          judgeModel: j.modelId,
          score: hit.score,
          criteria: hit.criteria ?? undefined,
          rationale: hit.rationale ?? undefined,
          cached: true,
          withoutAttachments: hit.withoutAttachments,
        };
      }

      const t0 = performance.now();
      let outcome: JudgeOutcome;
      try {
        let v = await callJudge(j, prompt, opts.rubric, attachments);
        let withoutAttachments = false;
        if (attachments.length && flatVerdict(v)) {
          // fallback: same material without the files, so the judge scores against the reference only
          const textOnly = buildPrompt(opts.rubric, { ...opts.material, attachments: [] }, opts.lang, opts.responseLanguage ?? 'case');
          v = await callJudge(j, textOnly, opts.rubric);
          withoutAttachments = true;
        }
        outcome = {
          withoutAttachments,
          judge: j.id,
          judgeModel: j.modelId,
          score: clamp(v.score),
          criteria: v.criteria.map((c) => ({ ...c, score: clamp(c.score) })),
          rationale: v.rationale,
          latencyMs: performance.now() - t0,
          cached: false,
        };
      } catch (e) {
        outcome = {
          judge: j.id,
          judgeModel: j.modelId,
          score: null,
          latencyMs: performance.now() - t0,
          cached: false,
          error: (e as Error).message?.slice(0, 500),
        };
      }
      db.insert(schema.judgments)
        .values({
          caseResultId: opts.caseResultId,
          judge: j.id,
          judgeModel: j.modelId,
          rubricVersion: opts.rubric.version,
          cacheKey,
          score: outcome.score,
          criteria: outcome.criteria,
          rationale: outcome.rationale,
          latencyMs: outcome.latencyMs,
          cached: false,
          error: outcome.error,
          withoutAttachments: outcome.withoutAttachments ?? false,
        })
        .run();
      return outcome;
    }),
  );
}
