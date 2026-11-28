// How files reach Ollama models (images natively, everything else as extracted text), on the real sample files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilePart } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  DOCX_MEDIA_TYPE,
  extractFileText,
  formatFilePartForOllama,
  isTextMediaType,
  mediaTypeOf,
  OLLAMA_FILE_POLICY,
  UnsupportedFileTypeError,
  XLSX_MEDIA_TYPE,
} from '@/lib/files/file-part';

const sample = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), '.data', 'files', name)));
const part = (data: Uint8Array, mediaType: string, filename?: string): FilePart => ({ type: 'file', data, mediaType, filename });

describe('decodeText', () => {
  it('UTF-8, with the BOM dropped', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('città')]))).toBe('città');
  });
  it('falls back to Windows-1252 for invalid UTF-8 (Excel CSV on Windows)', () => {
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x80]))).toBe('café€');
  });
});

describe('media types and policy', () => {
  it('recognises text formats', () => {
    for (const t of ['text/csv', 'application/json', 'application/ld+json', 'application/x-yaml']) expect(isTextMediaType(t)).toBe(true);
    expect(isTextMediaType('application/pdf')).toBe(false);
  });

  it('maps file extensions, and refuses unknown ones', () => {
    expect(mediaTypeOf('Report.PDF')).toBe('application/pdf');
    expect(mediaTypeOf('sheet.xlsx')).toBe(XLSX_MEDIA_TYPE);
    expect(() => mediaTypeOf('archive.zip')).toThrow(/Unknown media type/);
  });

  it('Ollama: images native, audio/video unsupported, the rest as a text part', () => {
    expect(OLLAMA_FILE_POLICY('image/png')).toBe('native');
    expect(OLLAMA_FILE_POLICY('audio/mpeg')).toBe('unsupported');
    expect(OLLAMA_FILE_POLICY('application/pdf')).toBe('text-part');
  });
});

describe('formatFilePartForOllama', () => {
  it('passes images through unchanged', async () => {
    const img = part(sample('wmr_fb_final.jpg'), 'image/jpeg', 'wmr_fb_final.jpg');
    expect(await formatFilePartForOllama(img)).toBe(img);
  });

  it('wraps text files in a <file> text part', async () => {
    const out = await formatFilePartForOllama(part(new TextEncoder().encode('a,b\n1,2'), 'text/csv', 'data.csv'));
    expect(out).toEqual({ type: 'text', text: '<file name="data.csv" type="text/csv">\na,b\n1,2\n</file>' });
  });

  it('refuses audio with a clear error', async () => {
    await expect(formatFilePartForOllama(part(new Uint8Array([1]), 'audio/wav'))).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });
});

describe('extractFileText on the sample files', () => {
  it('CSV', async () => {
    const { text, mediaType } = await extractFileText(sample('FFIListExample3.0.csv'), 'text/csv');
    expect(mediaType).toBe('text/csv');
    expect(text.split('\n')[0]).toContain('GIIN');
  });

  it('XLSX: one CSV per sheet, headed by the sheet name', async () => {
    const { text, mediaType } = await extractFileText(sample('17incdak.xlsx'), XLSX_MEDIA_TYPE);
    expect(mediaType).toBe('text/csv');
    expect(text).toMatch(/^# .+\n/);
    expect(text).not.toMatch(/,\n|,$/m); // no trailing empty cells
  });

  it('DOCX and PDF: their text', async () => {
    const docx = await extractFileText(sample('17incddocguide.docx'), DOCX_MEDIA_TYPE);
    expect(docx.mediaType).toBe('text/plain');
    expect(docx.text.length).toBeGreaterThan(500);
    const pdf = await extractFileText(sample('i1095a.pdf'), 'application/pdf');
    expect(pdf.text).toMatch(/1095-A/);
  });
});
