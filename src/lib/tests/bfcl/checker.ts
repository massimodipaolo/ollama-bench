/**
 * TypeScript port of the BFCL single-turn AST checker (berkeley-function-call-leaderboard, ast_checker.py), scope:
 * simple / multiple / parallel / parallel_multiple / irrelevance. Ground truth: [{ funcName: { param: [acceptable…] } }]
 * where "" among the acceptable values means the parameter may be omitted.
 */

export interface BfclFunction {
  name: string;
  description?: string;
  parameters: { type: string; properties: Record<string, BfclParam>; required?: string[] };
}
export interface BfclParam {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: BfclParam;
  properties?: Record<string, BfclParam>;
  required?: string[];
  default?: unknown;
}
export type GroundTruth = Record<string, Record<string, unknown[]>>[];
export interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** BFCL's string standardization: lowercase, drop spaces and , . / - _ * ^ */
export const standardize = (s: string) => s.toLowerCase().replace(/[ ,./\-_*^]/g, '');

/** Tool names must be [a-zA-Z0-9_-]: BFCL names like "math.factorial" are sent as "math_factorial". */
export const toolName = (n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_');

function typeOk(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value);
    case 'float':
    case 'number':
      return typeof value === 'number'; // an int is accepted for a float param
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
    case 'tuple':
      return Array.isArray(value);
    case 'dict':
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true; // "any" / unknown
  }
}

function valueEquals(value: unknown, expected: unknown, param?: BfclParam): boolean {
  if (typeof expected === 'string') return typeof value === 'string' && standardize(value) === standardize(expected);
  if (typeof expected === 'number') return typeof value === 'number' && value === expected;
  if (typeof expected === 'boolean') return value === expected;
  if (Array.isArray(expected)) {
    return Array.isArray(value) && value.length === expected.length && expected.every((e, i) => valueEquals(value[i], e, param?.items));
  }
  if (expected && typeof expected === 'object') {
    // dict ground truth: each key maps to a list of acceptable values
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const exp = expected as Record<string, unknown[]>;
    for (const k of Object.keys(v)) if (!(k in exp)) return false;
    return Object.entries(exp).every(([k, acceptable]) => {
      const list = Array.isArray(acceptable) ? acceptable : [acceptable];
      if (!(k in v)) return list.includes('');
      return list.some((a) => a !== '' && valueEquals(v[k], a, param?.properties?.[k]));
    });
  }
  return value === expected;
}

/** Why one call fails against one ground-truth entry (null = match). */
export function callMismatch(call: Call, gt: GroundTruth[number], functions: BfclFunction[]): string | null {
  const [gtName, gtParams] = Object.entries(gt)[0];
  if (call.name !== toolName(gtName)) return `called ${call.name}, expected ${gtName}`;
  const fn = functions.find((f) => toolName(f.name) === call.name);
  const props = fn?.parameters.properties ?? {};
  for (const r of fn?.parameters.required ?? []) if (!(r in call.args)) return `missing required "${r}"`;
  for (const k of Object.keys(call.args)) if (!(k in gtParams)) return `unexpected parameter "${k}"`;
  for (const [k, acceptable] of Object.entries(gtParams)) {
    if (!(k in call.args)) {
      if (acceptable.includes('')) continue;
      return `missing "${k}"`;
    }
    const v = call.args[k];
    if (!typeOk(v, props[k]?.type)) return `"${k}" has the wrong type (${JSON.stringify(v)} for ${props[k]?.type})`;
    if (!acceptable.some((a) => a !== '' && valueEquals(v, a, props[k])))
      return `"${k}" = ${JSON.stringify(v)} not in ${JSON.stringify(acceptable.filter((a) => a !== ''))}`;
  }
  return null;
}

/** BFCL verdict for a whole response (one turn). */
export function checkCalls(category: string, calls: Call[], gt: GroundTruth, functions: BfclFunction[]): { pass: boolean; detail: string } {
  if (category === 'irrelevance')
    return calls.length === 0
      ? { pass: true, detail: 'no call' }
      : { pass: false, detail: `called ${calls.map((c) => c.name).join(', ')}` };
  if (calls.length !== gt.length) return { pass: false, detail: `${calls.length} call(s), expected ${gt.length}` };
  if (gt.length === 1) {
    const why = callMismatch(calls[0], gt[0], functions);
    return why ? { pass: false, detail: why } : { pass: true, detail: 'match' };
  }
  // parallel: every ground-truth entry matched by a distinct call, in any order (backtracking)
  const used = new Set<number>();
  let lastWhy = '';
  const match = (i: number): boolean => {
    if (i === gt.length) return true;
    for (let c = 0; c < calls.length; c++) {
      if (used.has(c)) continue;
      const why = callMismatch(calls[c], gt[i], functions);
      if (why) {
        lastWhy = why;
        continue;
      }
      used.add(c);
      if (match(i + 1)) return true;
      used.delete(c);
    }
    return false;
  };
  return match(0) ? { pass: true, detail: `all ${gt.length} calls match` } : { pass: false, detail: lastWhy || 'no matching assignment' };
}

/** BFCL parameter schema → JSON Schema (dict→object, float→number, tuple→array, any→{}). */
export function toJsonSchema(p: BfclParam | BfclFunction['parameters']): Record<string, unknown> {
  const t = p.type;
  const out: Record<string, unknown> = {};
  if (t === 'dict' || t === 'object') {
    out.type = 'object';
    out.properties = Object.fromEntries(Object.entries(p.properties ?? {}).map(([k, v]) => [k, toJsonSchema(v)]));
    if (p.required?.length) out.required = p.required;
  } else if (t === 'array' || t === 'tuple') {
    out.type = 'array';
    if ('items' in p && p.items) out.items = toJsonSchema(p.items);
  } else if (t === 'float') out.type = 'number';
  else if (t === 'integer' || t === 'string' || t === 'boolean' || t === 'number') out.type = t;
  if ('description' in p && p.description) out.description = p.description;
  if ('enum' in p && p.enum) out.enum = p.enum;
  if ('default' in p && p.default !== undefined)
    out.description = `${out.description ?? ''} (default: ${JSON.stringify(p.default)})`.trim();
  return out;
}
