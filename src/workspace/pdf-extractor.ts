import { NagexError } from '../common/errors.js';
import type { ProcessingChunk } from './workspace.types.js';

// Real PDF parsing (Phase 1 STEP 4). Earlier versions of this module used a
// hand-rolled regex/zlib walk over raw PDF object streams, which could not
// reliably extract text from real-world PDFs (compressed cross-reference
// tables, CID/Type0 fonts, multi-operator content streams, etc.). pdfjs-dist
// is a real, actively maintained PDF parser (the engine behind Firefox's PDF
// viewer) with zero native/runtime dependencies, so it is used here instead
// — this file only performs text extraction with it, never rendering, so no
// canvas/worker infrastructure is required.
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsModulePromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModulePromise;
}

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  characterStart: number;
  characterEnd: number;
}

export interface ExtractedPdfResult {
  // null only if the parser genuinely could not determine a page count —
  // never guessed (Phase 1 STEP 4, item D).
  pageCount: number | null;
  extractedCharacters: number;
  hasText: boolean;
  extractionMethod: string;
  extractionWarnings: string[];
  text: string;
  pages: ExtractedPdfPage[];
}

function normalizePdfText(raw: string): string {
  return raw
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function newRequestId(): string {
  return `req_pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdfResult> {
  if (!buffer || buffer.length === 0) {
    throw new NagexError({
      code: 'PDF_EMPTY',
      category: 'VALIDATION',
      message: 'PDF file binary data is empty.',
      request_id: newRequestId(),
    });
  }

  const head = buffer.toString('binary', 0, Math.min(buffer.length, 1024));
  if (!head.includes('%PDF-')) {
    throw new NagexError({
      code: 'INVALID_PDF',
      category: 'VALIDATION',
      message: 'Invalid PDF format: magic header %PDF- missing.',
      request_id: newRequestId(),
    });
  }

  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new NagexError({
      code: 'PDF_EXTRACTION_FAILED',
      category: 'VALIDATION',
      message: `PDF could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      request_id: newRequestId(),
    });
  }

  const warnings: string[] = [];
  const pageCount: number | null = typeof doc.numPages === 'number' ? doc.numPages : null;
  const rawPages: Array<{ pageNumber: number; text: string }> = [];

  try {
    for (let i = 1; i <= (pageCount || 0); i++) {
      let page;
      try {
        page = await doc.getPage(i);
        const content = await page.getTextContent();
        const rawPageText = content.items
          .map((it) => ('str' in it ? (it as { str: string }).str : ''))
          .join(' ');
        rawPages.push({ pageNumber: i, text: normalizePdfText(rawPageText) });
      } catch (err) {
        // A single unparsable page must not fail the whole document — surface
        // it as a truthful warning and keep whatever text the other pages
        // genuinely yielded (Phase 1 STEP 4, item F: never fabricate content
        // to paper over an extraction gap).
        warnings.push(`Page ${i} could not be extracted: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        page?.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  const pages: ExtractedPdfPage[] = [];
  let text = '';
  for (const rp of rawPages) {
    if (rp.text.length === 0) {
      pages.push({ pageNumber: rp.pageNumber, text: '', characterStart: text.length, characterEnd: text.length });
      continue;
    }
    if (text.length > 0) text += '\n\n';
    const start = text.length;
    text += rp.text;
    pages.push({ pageNumber: rp.pageNumber, text: rp.text, characterStart: start, characterEnd: text.length });
  }

  const extractedCharacters = text.length;
  const hasText = extractedCharacters > 0;
  if (!hasText) {
    warnings.push('No extractable text layer was found — this PDF may be a scanned image (OCR not performed).');
  }

  return {
    pageCount,
    extractedCharacters,
    hasText,
    extractionMethod: 'pdfjs-dist',
    extractionWarnings: warnings,
    text,
    pages,
  };
}

// Deterministic chunk identity (Phase 1 STEP 4, item G): the same captureId +
// contentHash always yields the same chunkIds, so a retry never mints new
// chunk identities for unchanged content, and candidates that cite a
// chunkId keep pointing at a stable, reproducible source.
export function chunkText(
  text: string,
  identitySeed: string,
  pages: ExtractedPdfPage[] | undefined,
  targetTokenCount: number = 1000,
  overlapChars: number = 300,
): ProcessingChunk[] {
  const charsPerToken = 4;
  const targetChars = Math.max(targetTokenCount * charsPerToken, overlapChars + 1);

  const chunks: ProcessingChunk[] = [];
  let chunkIndex = 0;

  const pushChunk = (chunkText_: string, characterStart: number, pageStart: number | null, pageEnd: number | null) => {
    if (!chunkText_.trim()) return;
    chunks.push({
      chunkId: `chk_${identitySeed}_${chunkIndex}`,
      text: chunkText_,
      pageStart,
      pageEnd,
      characterStart,
      characterEnd: characterStart + chunkText_.length,
      tokenEstimate: Math.ceil(chunkText_.length / charsPerToken),
    });
    chunkIndex += 1;
  };

  if (pages && pages.length > 0) {
    for (const page of pages) {
      if (!page.text) continue;
      let offset = 0;
      while (offset < page.text.length) {
        const piece = page.text.slice(offset, offset + targetChars);
        pushChunk(piece, page.characterStart + offset, page.pageNumber, page.pageNumber);
        const nextOffset = offset + targetChars - overlapChars;
        if (nextOffset <= offset) break;
        offset = nextOffset;
      }
    }
  } else {
    let offset = 0;
    while (offset < text.length) {
      const piece = text.slice(offset, offset + targetChars);
      pushChunk(piece, offset, null, null);
      const nextOffset = offset + targetChars - overlapChars;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }
  }

  return chunks;
}
