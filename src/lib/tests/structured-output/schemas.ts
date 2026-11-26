import { z } from 'zod';

/**
 * Schemas of increasing difficulty. Cases reference them by id.
 * Keys are language-neutral; free-text fields must be written in the case language.
 */

const isoDate = z.string().describe('date in ISO format YYYY-MM-DD');

/** Level 1, flat: scalars, one primitive array, one free-text field */
export const formBasics = z.object({
  formNumber: z.string().describe('form identifier, e.g. "1040"'),
  formTitle: z.string().describe('official title of the form'),
  taxYear: z.number().int().describe('calendar year of coverage the instructions refer to'),
  furnishDeadline: isoDate.describe('deadline to file with the IRS and furnish statements, YYYY-MM-DD'),
  filer: z.string().describe('who must file the form'),
  excludedPlans: z.array(z.string()).describe('kinds of plans for which the form must NOT be filed'),
  summary: z.string().describe('one-sentence summary of the purpose of the form'),
});

/** Level 2, nested objects and arrays of objects */
export const docOverview = z.object({
  title: z.string(),
  taxYear: z.number().int(),
  dataSource: z.object({
    agency: z.string().describe('full agency name'),
    division: z.string().describe('division that tabulates the data'),
    formType: z.string().describe('tax form number the data is based on'),
  }),
  filingPeriod: z.object({ start: isoDate, end: isoDate }),
  sections: z
    .array(z.object({ letter: z.string().describe('single uppercase letter'), title: z.string() }))
    .describe('table of contents, in order'),
  singleDistrictStates: z.array(z.string()).describe('postal codes of states with a single congressional district'),
  nineDigitMatchRatePercent: z.number().describe('share of returns matched on the 9-digit ZIP code, as a percentage number'),
  summary: z.string().describe('two-sentence summary of how the data is built'),
});

/** Level 3, long array with enum + derived fields */
export const ffiTable = z.object({
  institutions: z
    .array(
      z.object({
        giin: z.string().describe('GIIN exactly as written'),
        name: z.string().describe('institution name exactly as written'),
        country: z.string().describe('country name in English, as written'),
        category: z.enum(['LE', 'BR', 'ME', 'SP', 'SF', 'SD', 'SS', 'SB', 'SL']).describe('the third dot-separated segment of the GIIN'),
        isBranch: z.boolean().describe('true when the name denotes a branch'),
      }),
    )
    .describe('one entry per data row, in the original order'),
  countriesCount: z.number().int().describe('number of distinct countries'),
});

/** Level 4, enums + discriminated union + typed entity lists */
export const triage = z.object({
  category: z.enum(['refund_status', 'form_correction', 'identity_theft', 'general_question']),
  urgency: z.enum(['low', 'medium', 'high']),
  entities: z.object({
    formNumbers: z.array(z.string()).describe('tax form numbers mentioned, e.g. "1095-A"'),
    dates: z.array(isoDate).describe('dates mentioned, YYYY-MM-DD'),
    amounts: z.array(z.number()).describe('money amounts mentioned, as plain numbers'),
  }),
  action: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('reply'), replyText: z.string().describe('short answer to send to the taxpayer') }),
      z.object({
        type: z.literal('escalate'),
        team: z.enum(['fraud', 'corrections', 'billing']),
        reason: z.string().describe('one sentence for the receiving team'),
      }),
    ])
    .describe('reply directly when the question can be answered, otherwise escalate'),
});

export const SCHEMAS = { formBasics, docOverview, ffiTable, triage } as const;
export type SchemaId = keyof typeof SCHEMAS;
