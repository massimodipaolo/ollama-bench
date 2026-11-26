import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/** Downloaded benchmark data (pnpm datasets:fetch): .data/datasets/<name>/ — git-ignored, never committed. */
export const DATASETS_DIR = path.join(process.cwd(), '.data', 'datasets');

export const datasetPath = (name: string, ...p: string[]) => path.join(DATASETS_DIR, name, ...p);

export function datasetReady(name: string): boolean {
  return fs.existsSync(datasetPath(name, 'cases.json'));
}

/** English-only benchmarks: available once fetched. */
export const datasetLanguages = (name: string) => () => (datasetReady(name) ? ['en'] : []);

export function datasetCases<T>(name: string, lang: string): T[] {
  if (lang !== 'en') throw new Error(`${name} is English-only`);
  if (!datasetReady(name)) throw new Error(`${name} data not downloaded: run "pnpm datasets:fetch ${name}"`);
  return JSON.parse(fs.readFileSync(datasetPath(name, 'cases.json'), 'utf8')) as T[];
}
