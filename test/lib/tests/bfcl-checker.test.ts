// The TypeScript port of BFCL's AST checker: the whole score of the bfcl test.
import { describe, expect, it } from 'vitest';
import {
  callMismatch,
  checkCalls,
  standardize,
  toJsonSchema,
  toolName,
  type BfclFunction,
  type GroundTruth,
} from '@/lib/tests/bfcl/checker';

const functions: BfclFunction[] = [
  {
    name: 'math.factorial',
    parameters: { type: 'dict', properties: { number: { type: 'integer' } }, required: ['number'] },
  },
  {
    name: 'weather.get',
    parameters: {
      type: 'dict',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['C', 'F'] }, days: { type: 'integer' } },
      required: ['city'],
    },
  },
];

describe('helpers', () => {
  it('standardize drops case, spaces and , . / - _ * ^', () => {
    expect(standardize('New-York, N.Y.')).toBe('newyorkny');
  });
  it('toolName makes BFCL names valid tool names', () => {
    expect(toolName('math.factorial')).toBe('math_factorial');
  });
});

describe('callMismatch', () => {
  const gt: GroundTruth[number] = { 'weather.get': { city: ['San Francisco', 'SF'], unit: ['C', ''], days: [''] } };

  it('matches acceptable values, standardized, with optional parameters omitted', () => {
    expect(callMismatch({ name: 'weather_get', args: { city: 'san francisco' } }, gt, functions)).toBeNull();
    expect(callMismatch({ name: 'weather_get', args: { city: 'SF', unit: 'C' } }, gt, functions)).toBeNull();
  });

  it('explains each kind of mismatch', () => {
    expect(callMismatch({ name: 'math_factorial', args: {} }, gt, functions)).toBe('called math_factorial, expected weather.get');
    expect(callMismatch({ name: 'weather_get', args: { unit: 'C' } }, gt, functions)).toBe('missing required "city"');
    expect(callMismatch({ name: 'weather_get', args: { city: 'SF', country: 'US' } }, gt, functions)).toBe(
      'unexpected parameter "country"',
    );
    expect(callMismatch({ name: 'weather_get', args: { city: 'SF', days: 3 } }, gt, functions)).toMatch(/"days" = 3 not in/);
    expect(callMismatch({ name: 'weather_get', args: { city: 'Rome' } }, gt, functions)).toMatch(/"city" = "Rome" not in/);
  });

  it('checks types: an integer parameter rejects a float, a string rejects a number', () => {
    const fact: GroundTruth[number] = { 'math.factorial': { number: [5] } };
    expect(callMismatch({ name: 'math_factorial', args: { number: 5.5 } }, fact, functions)).toMatch(/wrong type/);
    expect(callMismatch({ name: 'weather_get', args: { city: 42 } }, gt, functions)).toMatch(/wrong type/);
  });
});

describe('checkCalls', () => {
  it('irrelevance: passes only when no function is called', () => {
    expect(checkCalls('irrelevance', [], [], functions).pass).toBe(true);
    expect(checkCalls('irrelevance', [{ name: 'math_factorial', args: { number: 3 } }], [], functions)).toMatchObject({
      pass: false,
      detail: 'called math_factorial',
    });
  });

  it('parallel: every expected call matched once, in any order', () => {
    const gt: GroundTruth = [{ 'math.factorial': { number: [3] } }, { 'math.factorial': { number: [5] } }];
    const calls = [
      { name: 'math_factorial', args: { number: 5 } },
      { name: 'math_factorial', args: { number: 3 } },
    ];
    expect(checkCalls('parallel', calls, gt, functions)).toEqual({ pass: true, detail: 'all 2 calls match' });
    expect(checkCalls('parallel', [calls[0], calls[0]], gt, functions).pass).toBe(false); // one call can't match twice
    expect(checkCalls('parallel', calls.slice(0, 1), gt, functions).detail).toBe('1 call(s), expected 2');
  });
});

describe('toJsonSchema', () => {
  it('maps BFCL types to JSON Schema', () => {
    expect(
      toJsonSchema({
        type: 'dict',
        properties: { x: { type: 'float', description: 'a value', default: 1 }, xs: { type: 'tuple', items: { type: 'integer' } } },
        required: ['x'],
      }),
    ).toEqual({
      type: 'object',
      properties: { x: { type: 'number', description: 'a value (default: 1)' }, xs: { type: 'array', items: { type: 'integer' } } },
      required: ['x'],
    });
  });

  it('keeps enums, items of arrays without a schema, and unknown types as "any"', () => {
    expect(toJsonSchema({ type: 'string', enum: ['C', 'F'] })).toEqual({ type: 'string', enum: ['C', 'F'] });
    expect(toJsonSchema({ type: 'array' })).toEqual({ type: 'array' });
    expect(toJsonSchema({ type: 'any' })).toEqual({});
  });
});

describe('argument values: types and nested ground truth', () => {
  const fn: BfclFunction = {
    name: 'book',
    parameters: {
      type: 'dict',
      properties: {
        flags: { type: 'boolean' },
        dates: { type: 'array', items: { type: 'string' } },
        prefs: { type: 'dict', properties: { seat: { type: 'string' }, meal: { type: 'string' } } },
        anything: { type: 'any' },
      },
    },
  };
  const check = (args: Record<string, unknown>, gt: Record<string, unknown[]>) => callMismatch({ name: 'book', args }, { book: gt }, [fn]);

  it('booleans, arrays in order, and any-typed values', () => {
    expect(check({ flags: true }, { flags: [true] })).toBeNull();
    expect(check({ flags: 'true' }, { flags: [true] })).toMatch(/wrong type/);
    expect(check({ dates: ['2026-01-01', '2026-01-02'] }, { dates: [['2026-01-01', '2026-01-02']] })).toBeNull();
    expect(check({ dates: ['2026-01-02', '2026-01-01'] }, { dates: [['2026-01-01', '2026-01-02']] })).toMatch(/not in/); // order matters
    expect(check({ anything: 42 }, { anything: [42] })).toBeNull();
  });

  it('dict values: each key against its acceptable values, optional keys may be omitted, extra keys fail', () => {
    const gt = { prefs: [{ seat: ['window', 'aisle'], meal: ['veg', ''] }] };
    expect(check({ prefs: { seat: 'Window' } }, gt)).toBeNull();
    expect(check({ prefs: { seat: 'middle' } }, gt)).toMatch(/not in/);
    expect(check({ prefs: { seat: 'aisle', pet: 'cat' } }, gt)).toMatch(/not in/);
    expect(check({ prefs: 'window' }, gt)).toMatch(/wrong type/);
  });
});
