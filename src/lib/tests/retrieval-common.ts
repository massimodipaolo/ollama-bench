import 'server-only';
import type { CheckResult } from '@/db/schema';
import type { Rubric, CaseOutput, JudgeMaterial } from './types';
import { readCases } from './fixtures';
import { loadCorpus, relevantIds, type Chunk, type Query } from '@/lib/rag/corpus';
import { rankMetrics } from '@/lib/rag/retrieval';

export type QueryCase = Query;

export const loadQueries = (lang: string) => readCases<QueryCase>('corpus', lang);

export interface RankedItem {
  id: string;
  doc: string;
  headingPath: string;
  score?: number;
  relevant: boolean;
}

export interface RankingData {
  ranked: RankedItem[];
  relevantIds: string[];
  /** reranking: how the candidates were scored (embedding | llm-listwise | cohere) */
  method?: string;
  /** reranking with an LLM: ids it returned that were invalid or duplicated */
  invalid?: number;
  /** reranking with an LLM: the model's raw answer (debugging) */
  raw?: string;
  /** pointwise scoring gave every passage the same score (e.g. flat logprobs from a broken model) */
  degenerate?: boolean;
  /** pointwise yes/no: passages where neither "yes" nor "no" was among the top next tokens */
  missingYesNo?: number;
}

export function toRanked(chunks: { chunk: Chunk; score?: number }[], rel: Set<string>): RankedItem[] {
  return chunks.map(({ chunk, score }) => ({
    id: chunk.id,
    doc: chunk.doc,
    headingPath: chunk.headingPath,
    score,
    relevant: rel.has(chunk.id),
  }));
}

export function relevantFor(q: QueryCase) {
  return relevantIds(q, loadCorpus().chunks);
}

/** Human-readable top-k list (UI output / judges). */
export function formatRanked(items: RankedItem[], k: number, withText = false): string {
  const byId = new Map(loadCorpus().chunks.map((c) => [c.id, c]));
  return items
    .slice(0, k)
    .map((it, i) => {
      const head = `${i + 1}. [${it.id}] ${it.headingPath}${it.score != null ? ` (score ${it.score.toFixed(3)})` : ''}`;
      return withText ? `${head}\n${byId.get(it.id)?.body ?? ''}` : head;
    })
    .join(withText ? '\n\n' : '\n');
}

export function rankingChecks(data: RankingData): CheckResult[] {
  const rel = new Set(data.relevantIds);
  const m = rankMetrics(
    data.ranked.map((r) => r.id),
    rel,
    10,
  );
  const checks: CheckResult[] = [
    { name: 'relevant at #1', pass: m.hitAt1 === 1, detail: m.firstRank ? `first relevant at #${m.firstRank}` : 'not in top 10' },
    { name: 'relevant in top 5', pass: m.hitAt5 === 1 },
    { name: `MRR ${m.mrr.toFixed(2)}`, pass: m.mrr >= 0.5, value: m.mrr },
    { name: `nDCG@10 ${m.ndcg.toFixed(2)}`, pass: m.ndcg >= 0.6, value: m.ndcg },
  ];
  if (data.invalid) checks.push({ name: 'valid ranking ids', pass: false, detail: `${data.invalid} invalid/duplicate ids` });
  if (data.degenerate)
    checks.push({
      name: 'scores vary across passages',
      pass: false,
      detail: 'every passage got the same score: the order is just the shuffled pool',
    });
  if (data.missingYesNo)
    checks.push({
      name: 'yes/no among top tokens',
      pass: false,
      detail: `${data.missingYesNo} of 20 passages: no "yes"/"no" in the top-20 next tokens`,
    });
  return checks;
}

export const RETRIEVAL_RUBRIC: Rubric = {
  version: 'ret-1',
  instructions:
    'A retrieval system returned the top passages for a question over a corpus of tax documents. Judge the ranked list, not the wording of the passages: does the top of the list contain the passage that answers the question, is the most useful passage ranked first, and how much irrelevant noise is above it? Use the reference answer to know what information is needed. The question may be in a different language from the passages (cross-lingual retrieval is expected).',
  criteria: [
    { name: 'Answer coverage', description: 'The information needed to answer is present in the top 5 passages.' },
    { name: 'Ranking quality', description: 'The most useful passage is ranked first; relevant passages are above irrelevant ones.' },
    { name: 'Precision', description: 'Little irrelevant noise among the top passages.' },
  ],
};

export function retrievalJudgeMaterial(q: QueryCase, out: CaseOutput, what: string): JudgeMaterial {
  const data = out.data as RankingData;
  return {
    task: `${what}: return the passages that best answer the question, best first.`,
    input: `Question: ${q.query}`,
    reference: `Reference answer: ${q.answer}`,
    response: `Top 5 passages, in ranked order:\n\n${formatRanked(data.ranked, 5, true)}`,
  };
}
