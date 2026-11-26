/**
 * Puts a file into a prompt the way Ollama handles best. Ported from the user's reference implementation
 * (file-part.ts, "File input matrix", 2026-11-15, AI SDK 7):
 *
 * - **ollama**: images only (as bytes). Every other file part, text file parts included, is dropped silently by
 *   ai-sdk-ollama, so everything else goes as a plain text part:
 *   `<file name="…" type="…">\n{text}\n</file>`.
 *
 * Extraction: text formats are decoded (UTF-8, else Windows-1252); XLSX → one CSV per sheet (no blank rows, no
 * trailing empty cells); DOCX → raw text (mammoth); PDF → text layer (unpdf), page by page.
 * Differences from the reference: XLSX uses exceljs instead of SheetJS `xlsx` (the npm build is 0.18.5 with known
 * CVEs); DOCX/PDF use mammoth/unpdf directly instead of the app's RAG readers (same libraries those readers wrap).
 */
import 'server-only';
import type { FilePart, TextPart } from 'ai';

export type FileStrategy = 'native' | 'text-file' | 'text-part' | 'unsupported';
export type FilePolicy = (mediaType: string) => FileStrategy;

export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const isImage = (mediaType: string) => mediaType.startsWith('image/');
const isAudioOrVideo = (mediaType: string) => mediaType.startsWith('audio/') || mediaType.startsWith('video/');
/** text formats: decoded, never sent as raw bytes */
export const isTextMediaType = (mediaType: string) =>
  mediaType.startsWith('text/') ||
  /^application\/(json|xml|x-ndjson|jsonl|yaml|x-yaml|csv|javascript)$/.test(mediaType) ||
  /\+(json|xml)$/.test(mediaType);

export const OLLAMA_FILE_POLICY: FilePolicy = (mediaType) =>
  isImage(mediaType) ? 'native' : isAudioOrVideo(mediaType) ? 'unsupported' : 'text-part';

export class UnsupportedFileTypeError extends Error {
  constructor(
    readonly provider: string,
    readonly mediaType: string,
  ) {
    super(`${provider} models can't read ${mediaType} files.`);
    this.name = 'UnsupportedFileTypeError';
  }
}

export function createFilePartFormatter(provider: string, policy: FilePolicy) {
  return async (part: FilePart): Promise<FilePart | TextPart> => {
    const strategy = policy(part.mediaType);
    switch (strategy) {
      case 'native':
        return part;
      case 'unsupported':
        throw new UnsupportedFileTypeError(provider, part.mediaType);
      case 'text-file':
      case 'text-part': {
        const { text, mediaType } = await extractFileText(filePartBytes(part), part.mediaType, part.filename);
        return strategy === 'text-file'
          ? { type: 'file', data: { type: 'text', text }, mediaType, filename: part.filename, providerOptions: part.providerOptions }
          : { type: 'text', text: `<file${part.filename ? ` name="${part.filename}"` : ''} type="${part.mediaType}">\n${text}\n</file>` };
      }
    }
  };
}

export const formatFilePartForOllama = createFilePartFormatter('ollama', OLLAMA_FILE_POLICY);

/** Bytes of an inline file part (this app only builds parts from local files). */
export function filePartBytes(part: FilePart): Uint8Array {
  const data = part.data as unknown;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'base64'));
  if (data && typeof data === 'object' && 'type' in data) {
    const tagged = data as { type: string; data?: unknown; text?: string };
    if (tagged.type === 'text') return new TextEncoder().encode(tagged.text ?? '');
    if (tagged.type === 'data') return filePartBytes({ ...part, data: tagged.data as never });
  }
  throw new Error(`Can't read the content of a file part (${part.mediaType}): use inline bytes.`);
}

/**
 * Text of a text file: UTF-8 when valid, else Windows-1252 (Excel's "CSV" on Windows, many government open-data
 * files), which decodes any byte. A leading BOM is dropped.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The content of a file as text, and the media type of that text. */
export async function extractFileText(
  bytes: Uint8Array,
  mediaType: string,
  filename?: string,
): Promise<{ text: string; mediaType: string }> {
  if (isTextMediaType(mediaType)) return { text: decodeText(bytes), mediaType };
  if (mediaType === XLSX_MEDIA_TYPE) return { text: await spreadsheetToCsv(bytes), mediaType: 'text/csv' };
  let text = '';
  if (mediaType === DOCX_MEDIA_TYPE) {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  } else if (mediaType === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes.slice());
    text = (await extractText(pdf, { mergePages: false })).text.join('\n');
  } else {
    throw new UnsupportedFileTypeError('ollama', mediaType);
  }
  if (!text.trim()) throw new Error(`No text could be extracted from ${filename ?? mediaType}.`);
  return { text, mediaType: 'text/plain' };
}

/** RFC 4180 field quoting. */
const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * One CSV per sheet, without blank rows or trailing empty cells (title rows span every column: a 27B model looped on
 * them). Cell values are the displayed text (formatted numbers, formula results).
 */
export async function spreadsheetToCsv(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return wb.worksheets
    .map((ws) => {
      const lines: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        for (let c = 1; c <= row.cellCount; c++) {
          const cell = row.getCell(c);
          // like SheetJS: a merged range's value only in its top-left cell
          cells.push(cell.isMerged && cell.master.address !== cell.address ? '' : cell.text.trim());
        }
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        if (cells.length) lines.push(cells.map(csvField).join(','));
      });
      return `# ${ws.name}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

const EXT_MEDIA: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': DOCX_MEDIA_TYPE,
  '.xlsx': XLSX_MEDIA_TYPE,
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function mediaTypeOf(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const t = EXT_MEDIA[ext];
  if (!t) throw new Error(`Unknown media type for ${filename}`);
  return t;
}
