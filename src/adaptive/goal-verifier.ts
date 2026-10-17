// GOAL-LEVEL VERIFICATION. A provider answering "200 OK" and a model saying "here is your image" are not success; success is what is true of the thing that was asked for.
// For an image that means: the bytes ARE an image (a real container, readable dimensions, not truncated), not a placeholder-sized speck, and the type the provider claimed matches what is there.
// The verdict carries the facts it was based on (type, size, dimensions, a hash), so an artifact can be identified later without trusting the provider's URL or label.
//
// Deterministic and dependency-free: it reads container headers only (PNG, JPEG, WebP, GIF). It does not judge beauty, relevance or quality - nothing here measures those, so nothing here claims them.
import { createHash } from 'node:crypto';

export type VerifiedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export type ImageProblem =
  | 'EMPTY'
  | 'TOO_SMALL_TO_BE_AN_IMAGE'
  | 'NOT_A_KNOWN_IMAGE_FORMAT'
  | 'TRUNCATED_OR_CORRUPT'
  | 'DIMENSIONS_UNREADABLE'
  | 'DIMENSIONS_TOO_SMALL'
  | 'DIMENSIONS_IMPLAUSIBLE'
  | 'CLAIMED_TYPE_MISMATCH';

export interface ImageVerification {
  ok: boolean;
  problems: ImageProblem[];
  mimeType: VerifiedImageMime | null;
  width: number | null;
  height: number | null;
  bytes: number;
  sha256: string | null;
}

export interface ImageVerificationOptions {
  /** the type the provider (or the caller) claimed; a different real type is reported (the real one wins) */
  claimedMime?: string;
  /** the shorter side must be at least this many pixels; a 1x1 or 16x16 file is not a mockup */
  minSide?: number;
  maxSide?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from('IEND', 'ascii');

interface Parsed { mime: VerifiedImageMime; width: number | null; height: number | null; complete: boolean }

function parsePng(b: Buffer): Parsed {
  const ihdr = b.length >= 33 && b.toString('ascii', 12, 16) === 'IHDR';
  const width = ihdr ? b.readUInt32BE(16) : null;
  const height = ihdr ? b.readUInt32BE(20) : null;
  // a complete PNG ends with an IEND chunk (length 0, "IEND", crc)
  const complete = b.length >= 45 && b.subarray(b.length - 8, b.length - 4).equals(PNG_IEND);
  return { mime: 'image/png', width, height, complete };
}

function parseJpeg(b: Buffer): Parsed {
  let width: number | null = null;
  let height: number | null = null;
  let offset = 2;
  while (offset + 4 < b.length) {
    if (b[offset] !== 0xff) { offset += 1; continue; }
    const marker = b[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
    const length = b.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 <= b.length) { height = b.readUInt16BE(offset + 5); width = b.readUInt16BE(offset + 7); }
      break;
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  // a complete JPEG ends with the EOI marker (some encoders pad after it, so look in the last few bytes)
  let complete = false;
  for (let i = Math.max(2, b.length - 16); i < b.length - 1; i += 1) if (b[i] === 0xff && b[i + 1] === 0xd9) complete = true;
  return { mime: 'image/jpeg', width, height, complete };
}

function parseWebp(b: Buffer): Parsed {
  const riffSize = b.readUInt32LE(4);
  const complete = riffSize + 8 === b.length || riffSize + 9 === b.length;
  const fourcc = b.toString('ascii', 12, 16);
  let width: number | null = null;
  let height: number | null = null;
  if (fourcc === 'VP8 ' && b.length >= 30) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
  else if (fourcc === 'VP8L' && b.length >= 25 && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
  else if (fourcc === 'VP8X' && b.length >= 30) { width = (b.readUIntLE(24, 3)) + 1; height = (b.readUIntLE(27, 3)) + 1; }
  return { mime: 'image/webp', width, height, complete };
}

function parseGif(b: Buffer): Parsed {
  return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), complete: b[b.length - 1] === 0x3b };
}

function detect(b: Buffer): Parsed | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return parsePng(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return parseJpeg(b);
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return parseWebp(b);
  if (b.length >= 10 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) return parseGif(b);
  return null;
}

export function verifyImageBytes(input: Buffer | Uint8Array | null | undefined, options: ImageVerificationOptions = {}): ImageVerification {
  const empty: ImageVerification = { ok: false, problems: ['EMPTY'], mimeType: null, width: null, height: null, bytes: 0, sha256: null };
  if (!input || input.length === 0) return empty;
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const base = { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  const problems: ImageProblem[] = [];
  if (buffer.length < 32) return { ok: false, problems: ['TOO_SMALL_TO_BE_AN_IMAGE'], mimeType: null, width: null, height: null, ...base };
  const parsed = detect(buffer);
  if (!parsed) return { ok: false, problems: ['NOT_A_KNOWN_IMAGE_FORMAT'], mimeType: null, width: null, height: null, ...base };
  if (!parsed.complete) problems.push('TRUNCATED_OR_CORRUPT');
  const { width, height } = parsed;
  if (!width || !height) problems.push('DIMENSIONS_UNREADABLE');
  else {
    const minSide = options.minSide ?? 64;
    const maxSide = options.maxSide ?? 16_384;
    if (Math.min(width, height) < minSide) problems.push('DIMENSIONS_TOO_SMALL');
    if (Math.max(width, height) > maxSide) problems.push('DIMENSIONS_IMPLAUSIBLE');
  }
  if (options.claimedMime) {
    const claimed = options.claimedMime.toLowerCase().replace('image/jpg', 'image/jpeg');
    if (claimed.startsWith('image/') && claimed !== parsed.mime) problems.push('CLAIMED_TYPE_MISMATCH');
  }
  // a wrong CLAIMED type alone is a labelling slip (the real type is used), not a bad image
  const fatal = problems.filter((p) => p !== 'CLAIMED_TYPE_MISMATCH');
  return { ok: fatal.length === 0, problems, mimeType: parsed.mime, width: width ?? null, height: height ?? null, ...base };
}
