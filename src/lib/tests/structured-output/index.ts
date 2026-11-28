import 'server-only';
import { Output } from 'ai';
import { z } from 'zod';
import type { TestDefinition, BaseCase, CaseOutput } from '../types';
import type { CheckResult } from '@/db/schema';
import { readCases } from '../fixtures';
import { runStream, toCaseOutput } from '../generate';
import { compareObjects, getPath, type CompareRules } from '../compare';
import { detectLanguage, wordCount } from '../checks';
import { SCHEMAS, type SchemaId } from './schemas';

interface StructuredCase extends BaseCase {
  schema: SchemaId;
  instruction: string;
  context: string;
  expected: Record<string, unknown>;
  /** free-text paths: excluded from field accuracy, checked for language, evaluated by judges */
  freeText: string[];
  rules?: CompareRules;
  note?: string;
}

interface StructuredData {
  mode: 'native' | 'prompt';
  parsed: unknown;
  jsonValid: boolean;
  schemaValid: boolean;
  schemaErrors?: string;
}

const SYSTEM =
  'You are a precise information-extraction engine. Respond with a single JSON object that conforms to the given JSON Schema. No prose, no code fences.';

function jsonSchemaOf(id: SchemaId) {
  return JSON.stringify(z.toJSONSchema(SCHEMAS[id]), null, 2);
}

function buildPrompt(c: StructuredCase) {
  return `${c.instruction}\n\nJSON Schema:\n${jsonSchemaOf(c.schema)}\n\nSource:\n<source>\n${c.context}\n</source>`;
}

/** Lenient JSON extraction for prompt mode: strips code fences / prose around the first {...} block. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('no JSON object found');
  }
}

export const structuredOutput: TestDefinition<StructuredCase> = {
  id: 'structured-output',
  name: 'Structured output (zod)',
  description:
    'Extraction into zod schemas of increasing complexity: flat, nested, long arrays with derived fields, enums and discriminated unions.',
  // 2: integers (years, counts) compared exactly; 1 accepted ±0.5% (a tax year within ±10)
  version: '2',
  requires: ['completion'],
  numCtx: 16384,
  options: [
    {
      id: 'mode',
      label: 'Mode',
      description:
        'native = Ollama constrained decoding with the JSON schema; prompt = schema only in the prompt (no grammar), tests raw JSON discipline.',
      choices: [
        { value: 'native', label: 'Native (constrained)' },
        { value: 'prompt', label: 'Prompt only' },
      ],
      default: 'native',
    },
  ],
  rubric: {
    version: 'so-1',
    instructions:
      'The response is a JSON object extracted from the source according to the schema. Compare values with the reference: wrong, missing or invented values are serious errors. For free-text fields, judge accuracy, faithfulness to the source and the required language. Invalid JSON or schema violations cap the score at 3.',
    criteria: [
      { name: 'Value accuracy', description: 'Extracted values are correct and complete with respect to the source/reference.' },
      { name: 'Schema adherence', description: 'Correct structure, types, enum values, formats (e.g. ISO dates).' },
      { name: 'No hallucination', description: 'Nothing invented beyond the source; derived fields follow the stated rules.' },
      { name: 'Free-text quality', description: 'Free-text fields are accurate, concise and in the required language.' },
    ],
  },
  loadCases: (lang) => readCases<StructuredCase>('structured-output', lang),

  async run(ctx, c) {
    const mode = (ctx.config.extra?.mode as 'native' | 'prompt') ?? 'native';
    const schema = SCHEMAS[c.schema];
    const r = await runStream(ctx, {
      system: SYSTEM,
      prompt: buildPrompt(c),
      maxOutputTokens: 4096,
      ...(mode === 'native' ? { output: Output.object({ schema }) } : {}),
    });

    let parsed: unknown = r.object;
    let jsonValid = r.object !== undefined;
    if (parsed === undefined) {
      try {
        parsed = extractJson(r.output);
        jsonValid = true;
      } catch {
        jsonValid = false;
      }
    }
    const sv = jsonValid ? schema.safeParse(parsed) : null;
    const data: StructuredData = {
      mode,
      parsed,
      jsonValid,
      schemaValid: !!sv?.success,
      schemaErrors: sv && !sv.success ? z.prettifyError(sv.error).slice(0, 800) : (r.objectError?.slice(0, 800) ?? undefined),
    };
    return { ...toCaseOutput(r), output: jsonValid ? JSON.stringify(parsed, null, 2) : r.output, data };
  },

  check(c, out, lang) {
    const d = out.data as StructuredData;
    const checks: CheckResult[] = [];
    if (d.mode === 'prompt') checks.push({ name: 'valid JSON', pass: d.jsonValid });
    checks.push({ name: 'matches schema', pass: d.schemaValid, detail: d.schemaErrors });
    if (!d.jsonValid) {
      checks.push({ name: 'field accuracy', pass: false, value: 0, detail: 'no JSON' });
      return checks;
    }
    const cmp = compareObjects(c.expected, d.parsed, { ...c.rules, ignore: [...(c.rules?.ignore ?? []), ...c.freeText] });
    const acc = cmp.total ? cmp.matched / cmp.total : 1;
    checks.push({
      name: `field accuracy ${cmp.matched}/${cmp.total}`,
      pass: acc >= 0.95,
      value: acc,
      detail: cmp.mismatches
        .slice(0, 8)
        .map((m) => `${m.path}: expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.actual)}`)
        .join('; '),
    });
    for (const p of c.freeText) {
      const v = getPath(d.parsed, p);
      if (typeof v !== 'string' || !v.trim()) {
        // a free-text path may legitimately be absent when a different union branch is expected
        if (getPath(c.expected, p.split('.').slice(0, -1).join('.') || p) !== undefined) checks.push({ name: `${p} present`, pass: false });
        continue;
      }
      if (wordCount(v) >= 4) {
        const det = detectLanguage(v);
        checks.push({ name: `${p} in ${lang.englishName}`, pass: det.code === lang.code, detail: `detected ${det.code}` });
      }
    }
    return checks;
  },

  judgeMaterial: (c, out: CaseOutput) => ({
    task: `${c.title}: extract structured data as JSON following the schema.`,
    input: buildPrompt(c),
    reference: `Expected values (free-text fields ${c.freeText.join(', ') || 'none'} are not fixed; "a || b" means either is acceptable):\n${JSON.stringify(c.expected, null, 2)}${c.note ? `\nNote: ${c.note}` : ''}`,
    response: out.output,
  }),
};
