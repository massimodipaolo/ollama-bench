/**
 * Supported test languages. To add one:
 *  1. add an entry here (stopwords drive the lightweight "response language" check)
 *  2. add fixtures/<test>/cases/<code>.json for each test (same case ids as the other languages)
 */
export interface LanguageConfig {
  code: string;
  name: string; // native name, shown in UI
  englishName: string; // used inside judge prompts
  stopwords: string[];
}

export const LANGUAGES: LanguageConfig[] = [
  {
    code: 'en',
    name: 'English',
    englishName: 'English',
    stopwords: [
      'the',
      'and',
      'is',
      'are',
      'of',
      'to',
      'in',
      'that',
      'it',
      'for',
      'with',
      'as',
      'was',
      'on',
      'this',
      'be',
      'by',
      'you',
      'not',
      'or',
      'your',
      'from',
      'have',
      'which',
      'will',
    ],
  },
  {
    code: 'it',
    name: 'Italiano',
    englishName: 'Italian',
    stopwords: [
      'il',
      'lo',
      'la',
      'gli',
      'le',
      'di',
      'che',
      'è',
      'e',
      'per',
      'un',
      'una',
      'del',
      'della',
      'non',
      'con',
      'sono',
      'nel',
      'alla',
      'si',
      'come',
      'anche',
      'più',
      'questo',
      'dei',
    ],
  },
];

export const DEFAULT_LANG = 'en';

export function getLanguage(code: string): LanguageConfig {
  const l = LANGUAGES.find((x) => x.code === code);
  if (!l) throw new Error(`Unknown language: ${code}`);
  return l;
}
