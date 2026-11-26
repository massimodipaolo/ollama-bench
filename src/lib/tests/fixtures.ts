import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FIXTURES_DIR = path.join(process.cwd(), 'fixtures');
export const FILES_DIR = path.join(process.cwd(), '.data', 'files');

export function casesPath(testId: string, lang: string) {
  return path.join(FIXTURES_DIR, testId, 'cases', `${lang}.json`);
}

export function hasCases(testId: string, lang: string) {
  return fs.existsSync(casesPath(testId, lang));
}

export function readCases<T>(testId: string, lang: string): T[] {
  const p = casesPath(testId, lang);
  if (!fs.existsSync(p)) throw new Error(`No ${lang} cases for test "${testId}" (expected ${p})`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T[];
}

/** Hash of the test version + every fixture file of the test (+ rubric), so edits produce a new suite version. */
export function suiteVersion(testId: string, testVersion: string, rubricVersion: string, extraDirs: string[] = []): string {
  const h = crypto.createHash('sha256').update(`${testVersion}|${rubricVersion}`);
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(e.name).update(fs.readFileSync(p));
    }
  };
  for (const d of [testId, ...extraDirs]) walk(path.join(FIXTURES_DIR, d));
  return `${testVersion}-${h.digest('hex').slice(0, 10)}`;
}

export function readSourceFile(name: string): Buffer {
  return fs.readFileSync(path.join(FILES_DIR, name));
}
