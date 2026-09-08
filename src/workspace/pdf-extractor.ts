import zlib from 'node:zlib';
import { NagexError } from '../common/errors.js';
import type { ProcessingChunk } from './workspace.types.js';

export interface ExtractedPdfResult {
  pageCount: number;
  characterCount: number;
  text: string;
  pages: Array<{ pageNumber: number; text: string }>;
}

export function extractPdfText(buffer: Buffer): ExtractedPdfResult {
  if (!buffer || buffer.length === 0) {
    throw new NagexError({
      code: 'PDF_PARSE_FAILED',
      category: 'VALIDATION',
      message: 'PDF file binary data is empty.',
      request_id: `req_pdf_${Date.now()}`,
    });
  }

  const strHead = buffer.toString('binary', 0, Math.min(buffer.length, 1024));
  if (!strHead.includes('%PDF-')) {
    throw new NagexError({
      code: 'PDF_CORRUPT',
      category: 'VALIDATION',
      message: 'Invalid PDF format: magic header %PDF- missing.',
      request_id: `req_pdf_${Date.now()}`,
    });
  }

  const rawStr = buffer.toString('binary');
  const pageMatches = rawStr.match(/\/Type\s*\/Page\b/g);
  const estimatedPageCount = Math.max(1, pageMatches ? pageMatches.length : 1);

  const pagesText: string[] = [];
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(rawStr)) !== null) {
    const streamStartIdx = match.index;
    const streamContentStart = streamStartIdx + match[0].indexOf('\n') + 1;
    const streamContentEnd = match.index + match[0].lastIndexOf('\nendstream');

    if (streamContentStart >= streamContentEnd) continue;

    const dictHeader = rawStr.slice(Math.max(0, streamStartIdx - 300), streamStartIdx);
    const isFlate = dictHeader.includes('/FlateDecode') || dictHeader.includes('/Fl');

    let streamBuf: Buffer = buffer.subarray(streamContentStart, streamContentEnd);
    if (isFlate) {
      try {
        streamBuf = zlib.inflateSync(streamBuf);
      } catch {
        try {
          streamBuf = zlib.unzipSync(streamBuf);
        } catch {
          /* keep raw streamBuf if inflate fails */
        }
      }
    }

    const textContent = streamBuf.toString('utf8');
    const extractedStreamText = parsePdfStreamText(textContent);
    if (extractedStreamText.trim()) {
      pagesText.push(extractedStreamText.trim());
    }
  }

  let fullText = pagesText.join('\n\n');
  if (!fullText.trim()) {
    fullText = parsePdfStreamText(rawStr);
  }

  const cleanedText = fullText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const characterCount = cleanedText.length;

  if (characterCount === 0) {
    throw new NagexError({
      code: 'PDF_NO_TEXT',
      category: 'VALIDATION',
      message: 'PDF file contains no extractable text.',
      request_id: `req_pdf_${Date.now()}`,
    });
  }

  const pages = pagesText.length > 0
    ? pagesText.map((t, idx) => ({ pageNumber: idx + 1, text: t }))
    : [{ pageNumber: 1, text: cleanedText }];

  return {
    pageCount: Math.max(pages.length, estimatedPageCount),
    characterCount,
    text: cleanedText,
    pages,
  };
}

function parsePdfStreamText(content: string): string {
  const textPieces: string[] = [];
  const btRegex = /BT([\s\S]*?)ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRegex.exec(content)) !== null) {
    const block = btMatch[1];
    const tjRegex = /\(([\s\S]*?)\)\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
    let tjMatch: RegExpExecArray | null;

    while ((tjMatch = tjRegex.exec(block)) !== null) {
      if (tjMatch[1] !== undefined) {
        textPieces.push(unescapePdfString(tjMatch[1]));
      } else if (tjMatch[2] !== undefined) {
        const tjBlock = tjMatch[2];
        const innerStrRegex = /\(([\s\S]*?)\)/g;
        let innerMatch: RegExpExecArray | null;
        while ((innerMatch = innerStrRegex.exec(tjBlock)) !== null) {
          textPieces.push(unescapePdfString(innerMatch[1]));
        }
      } else if (tjMatch[3] !== undefined) {
        textPieces.push(hexDecodePdf(tjMatch[3]));
      }
    }
  }

  if (textPieces.length === 0) {
    const fallbackTj = /\(([\s\S]*?)\)\s*Tj/g;
    let fbMatch: RegExpExecArray | null;
    while ((fbMatch = fallbackTj.exec(content)) !== null) {
      textPieces.push(unescapePdfString(fbMatch[1]));
    }
  }

  return textPieces.join(' ');
}

function unescapePdfString(str: string): string {
  return str
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function hexDecodePdf(hex: string): string {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.substring(i, i + 2), 16);
    if (!isNaN(code) && code > 0) {
      str += String.fromCharCode(code);
    }
  }
  return str;
}

export function chunkText(
  text: string,
  targetTokenCount: number = 1000,
  overlapChars: number = 300,
  pages?: Array<{ pageNumber: number; text: string }>
): ProcessingChunk[] {
  const charsPerToken = 4;
  const targetChars = targetTokenCount * charsPerToken; // ~4000 chars

  const chunks: ProcessingChunk[] = [];
  let chunkIndex = 1;

  if (pages && pages.length > 0) {
    for (const page of pages) {
      let offset = 0;
      while (offset < page.text.length) {
        const chunkTextContent = page.text.slice(offset, offset + targetChars);
        if (chunkTextContent.trim()) {
          chunks.push({
            chunkId: `chk_${chunkIndex++}`,
            text: chunkTextContent,
            pageNumber: page.pageNumber,
            tokenEstimate: Math.ceil(chunkTextContent.length / charsPerToken),
          });
        }
        offset += targetChars - overlapChars;
        if (offset >= page.text.length && offset < page.text.length + overlapChars) break;
      }
    }
  } else {
    let offset = 0;
    while (offset < text.length) {
      const chunkTextContent = text.slice(offset, offset + targetChars);
      if (chunkTextContent.trim()) {
        chunks.push({
          chunkId: `chk_${chunkIndex++}`,
          text: chunkTextContent,
          tokenEstimate: Math.ceil(chunkTextContent.length / charsPerToken),
        });
      }
      offset += targetChars - overlapChars;
      if (offset >= text.length && offset < text.length + overlapChars) break;
    }
  }

  return chunks;
}
