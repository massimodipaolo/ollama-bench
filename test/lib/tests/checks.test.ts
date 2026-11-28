import { describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import type { MermaidAnalysis } from '@/lib/mermaid-check';
import { autoScore, detectLanguage, extractNumbers, needsMermaid, runCheck, wordCount, type CheckSpec } from '@/lib/tests/checks';

const en = getLanguage('en');
const it_ = getLanguage('it');
const check = (spec: CheckSpec, output: string, lang = en) => runCheck(spec, output, lang);

describe('wordCount', () => {
  it('counts words across any whitespace', () => {
    expect(wordCount('  one two\tthree\nfour  ')).toBe(4);
    expect(wordCount('')).toBe(0);
  });
});

describe('extractNumbers (locale-tolerant)', () => {
  it.each([
    ['2,472 items', [2472]],
    ['2.472 items', [2472]],
    ['2 472 items', [2472]],
    ['ratio 0,80', [0.8]],
    ['ratio 0.80', [0.8]],
    ['1.234', [1234]], // ambiguous: read as thousands, as the fixtures expect
    ['-15 and 3.5', [-15, 3.5]],
    ['1,234,567.89', [1234567.89]],
  ])('%s', (text, expected) => {
    expect(extractNumbers(text)).toEqual(expected);
  });

  it('finds nothing in text without digits', () => {
    expect(extractNumbers('no numbers here')).toEqual([]);
  });
});

describe('detectLanguage', () => {
  it('recognises English and Italian by their stopwords', () => {
    expect(detectLanguage('This is the answer and it is in the text of the document').code).toBe('en');
    expect(detectLanguage('Questa è la risposta e si trova nel testo del documento').code).toBe('it');
  });

  it('returns unknown without letters', () => {
    expect(detectLanguage('12 34 !!')).toEqual({ code: 'unknown', confidence: 0 });
  });
});

describe('runCheck', () => {
  it('word limits', () => {
    expect(check({ type: 'maxWords', value: 3 }, 'one two three')).toMatchObject({ pass: true, detail: '3 words' });
    expect(check({ type: 'maxWords', value: 2 }, 'one two three').pass).toBe(false);
    expect(check({ type: 'minWords', value: 3 }, 'one two').pass).toBe(false);
  });

  it('bullet and numbered list counts', () => {
    const bullets = '- a\n* b\n• c\nnot a bullet';
    expect(check({ type: 'bulletCount', value: 3 }, bullets)).toMatchObject({ pass: true, detail: '3 bullets' });
    expect(check({ type: 'numberedCount', value: 2 }, '1. a\n2) b\n3 c')).toMatchObject({ pass: true, detail: '2 items' });
  });

  it('includes: case- and Unicode-insensitive, with partial credit', () => {
    const r = check({ type: 'includes', values: ['Rome', 'PARIS', 'Berlin', 'Madrid'] }, 'rome and paris');
    expect(r.pass).toBe(false);
    expect(r.value).toBe(0.5);
    expect(r.detail).toBe('missing: Berlin, Madrid');
    expect(check({ type: 'includes', values: ['ﬁle'] }, 'the file').pass).toBe(true); // NFKC: the ligature is "fi"
  });

  it('includesAny and excludes', () => {
    expect(check({ type: 'includesAny', values: ['yes', 'sì'] }, 'Sì, certo')).toMatchObject({ pass: true, detail: 'found "sì"' });
    expect(check({ type: 'excludes', values: ['as an AI'] }, 'As an AI, I cannot')).toMatchObject({
      pass: false,
      detail: 'found: as an AI',
    });
  });

  it('regex checks are case-insensitive by default, unless flags say otherwise', () => {
    expect(check({ type: 'regex', pattern: '^answer:' }, 'ANSWER: 4').pass).toBe(true);
    expect(check({ type: 'regex', pattern: '^answer:', flags: '' }, 'ANSWER: 4').pass).toBe(false);
    expect(check({ type: 'notRegex', pattern: 'sorry' }, 'Sorry, no').pass).toBe(false);
  });

  it('number with tolerance', () => {
    expect(check({ type: 'number', value: 2472 }, 'The total is 2.472.').pass).toBe(true);
    expect(check({ type: 'number', value: 10, tolerance: 0.5 }, 'about 10.4')).toMatchObject({ pass: true, name: 'answer = 10 ±0.5' });
    expect(check({ type: 'number', value: 10 }, 'no idea')).toMatchObject({ pass: false, detail: 'no number' });
  });

  it('inOrder: half credit for the right items in the wrong order', () => {
    expect(check({ type: 'inOrder', values: ['first', 'second', 'third'] }, 'first, second, third')).toMatchObject({
      pass: true,
      value: 1,
    });
    const swapped = check({ type: 'inOrder', values: ['first', 'second'] }, 'second then first');
    expect(swapped).toMatchObject({ pass: false, value: 0.5, detail: 'wrong order' });
    const missing = check({ type: 'inOrder', values: ['a1', 'b2', 'c3'] }, 'a1 c3');
    expect(missing.value).toBeCloseTo(2 / 3);
    expect(missing.detail).toBe('missing: b2');
  });

  it('language check uses the session language', () => {
    expect(check({ type: 'language' }, 'Questa è la risposta corretta per il problema', it_).pass).toBe(true);
    expect(check({ type: 'language' }, 'This is the answer to the problem', it_)).toMatchObject({
      pass: false,
      name: 'answers in Italian',
    });
  });
});

describe('Mermaid checks (on an analysis computed beforehand)', () => {
  const flowchart: MermaidAnalysis = {
    blocks: 1,
    extraText: false,
    valid: true,
    diagramType: 'flowchart-v2',
    nodes: 14,
    decisions: 3,
    subgraphs: 2,
    subgraphTitles: ['Intake', 'Refund'],
    labelledEdges: 4,
    hasCycle: true,
    labels: ['Check status', 'Retry payment'],
    edgeLabels: ['approved'],
  };
  const mermaid = (spec: CheckSpec, m?: MermaidAnalysis) => runCheck(spec, '', en, { mermaid: m });

  it('needsMermaid spots the specs that need the parser', () => {
    expect(needsMermaid([{ type: 'maxWords', value: 1 }])).toBe(false);
    expect(needsMermaid([{ type: 'mermaidGraph' }])).toBe(true);
  });

  it('valid block of the right type, alone', () => {
    expect(mermaid({ type: 'mermaid', diagram: 'flowchart', onlyBlock: true }, flowchart).pass).toBe(true);
    expect(mermaid({ type: 'mermaid', diagram: 'sequence' }, flowchart).detail).toContain('expected sequence');
    expect(mermaid({ type: 'mermaid', onlyBlock: true }, { ...flowchart, extraText: true }).detail).toBe('text outside the code block');
    expect(mermaid({ type: 'mermaid' }, { blocks: 2, extraText: false, valid: true }).detail).toBe('2 blocks (expected 1)');
    expect(mermaid({ type: 'mermaid' }, undefined)).toMatchObject({ pass: false, detail: 'not analysed' });
  });

  it('graph structure: partial credit per requirement met', () => {
    const spec: CheckSpec = {
      type: 'mermaidGraph',
      minNodes: 12,
      maxNodes: 25,
      minDecisions: 2,
      minSubgraphs: 2,
      minLabelledEdges: 6, // not met (4)
      cycle: true,
      labels: ['retry', 'approved', 'escalate'], // "escalate" not met
      subgraphTitles: ['refund'],
    };
    const r = mermaid(spec, flowchart);
    expect(r.pass).toBe(false);
    expect(r.value).toBeCloseTo(7 / 9);
    expect(r.detail).toContain('4 labelled edges (≥ 6)');
    expect(r.detail).toContain('label "escalate"');
  });

  it('graph structure of a diagram that does not parse scores 0', () => {
    expect(mermaid({ type: 'mermaidGraph', minNodes: 1 }, { blocks: 1, extraText: false, valid: false })).toMatchObject({
      pass: false,
      value: 0,
      detail: 'diagram does not parse',
    });
  });
});

describe('autoScore', () => {
  it('is the 0-10 mean of check values, partial credit included', () => {
    expect(autoScore([])).toBeNull();
    expect(
      autoScore([
        { name: 'a', pass: true },
        { name: 'b', pass: false },
        { name: 'c', pass: false, value: 0.5 },
      ]),
    ).toBe(5);
  });
});
