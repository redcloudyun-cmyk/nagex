// Outcome Quality for images and videos: what can be CHECKED about a picture or a clip a provider returned, without asking a model whether it likes it.
//
//   IMAGE  - the bytes are a PNG or a JPEG (not a page of HTML or an error body saved as .png), the size is at least what was asked for, the aspect ratio is the one asked for, the picture is not blank or a
//            flat fill (pixel statistics measured by decoding it in a real browser: scripts/image-quality-measure.mjs), the text the request wanted drawn is legible (read back by an OCR / vision reader:
//            an ADVISORY measurement, named as such), and an EDIT really differs from the picture it was made from yet keeps its shape.
//   VIDEO  - the bytes are an MP4 whose header says what it holds: the duration, the frame size, the aspect ratio, a video track with a known codec, an audio track when one was asked for (read from the
//            file's own boxes, no library), and - measured by a real player - that it plays and its clock advances.
//
// A check that needs a measurement nobody made is NOT_RUN, never PASS. Whether a picture matches the PROMPT, whether a scene is consistent from shot to shot, whether a face looks right: those are
// human review (or a vision model, named as advisory) and are reported as a separate, explicitly unreliable layer - never folded into QUALITY_PASS.
import { createHash } from 'node:crypto';
import { imageSize } from '../image-size.js';
import type { CheckStatus, QualityCheck, QualityReport, Verdict } from './outcome-quality.js';

const check = (id: string, kind: QualityCheck['kind'], status: CheckStatus, detail: string): QualityCheck => ({ id, kind, status, detail });
function verdict(checks: QualityCheck[], kind: QualityCheck['kind']): Verdict {
  const own = checks.filter((c) => c.kind === kind);
  if (own.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (own.length > 0 && own.every((c) => c.status === 'NOT_RUN')) return 'NOT_RUN';
  return own.some((c) => c.status === 'NOT_RUN') ? 'PARTIAL' : 'PASS';
}
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// ── images ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:2';
const RATIO: Record<AspectRatio, number> = { '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:2': 3 / 2 };

export interface ImageExpectation {
  scenario?: 'CREATE' | 'EDIT';
  minWidth?: number;
  minHeight?: number;
  aspectRatio?: AspectRatio;
  /** the aspect ratio may differ from the one asked for by this much (default 3%) */
  aspectTolerance?: number;
  /** text the request wanted drawn in the picture */
  text?: string[];
  /** EDIT: the picture it was made from */
  parent?: { bytes: Buffer };
}
/** Measured by decoding the picture in a real browser (scripts/image-quality-measure.mjs). */
export interface ImagePixelFacts { width: number; height: number; meanLuma: number; stdLuma: number; distinctColors: number; edgeShare: number }
/** Read back by an OCR / vision reader. ADVISORY: an OCR can miss text that is there; a vision model may be the very provider that drew the picture. */
export interface ImageTextFacts { recognized: string; engine: string }

export function evaluateImage(bytes: Buffer, expectation: ImageExpectation, pixels?: ImagePixelFacts, text?: ImageTextFacts): QualityReport {
  const checks: QualityCheck[] = [];
  const info = imageSize(bytes);
  checks.push(check('FORMAT_IS_PNG_OR_JPEG', 'TECHNICAL', info ? 'PASS' : 'FAIL', info ? `${info.extension.toUpperCase()} ${info.width}x${info.height}` : 'the bytes are not a PNG or a JPEG (an error page or another format saved under an image name)'));
  if (info) {
    if (expectation.minWidth || expectation.minHeight) {
      const ok = info.width >= (expectation.minWidth ?? 0) && info.height >= (expectation.minHeight ?? 0);
      checks.push(check('RESOLUTION_AT_LEAST_ASKED', 'QUALITY', ok ? 'PASS' : 'FAIL', `${info.width}x${info.height}, at least ${expectation.minWidth ?? 0}x${expectation.minHeight ?? 0} asked`));
    }
    if (expectation.aspectRatio) {
      const want = RATIO[expectation.aspectRatio];
      const got = info.width / info.height;
      const tolerance = expectation.aspectTolerance ?? 0.03;
      checks.push(check('ASPECT_RATIO_AS_ASKED', 'QUALITY', Math.abs(got - want) / want <= tolerance ? 'PASS' : 'FAIL', `${got.toFixed(3)} (${info.width}x${info.height}), ${expectation.aspectRatio} = ${want.toFixed(3)} asked`));
    }
  }
  if (!pixels) {
    checks.push(check('NOT_BLANK_OR_FLAT', 'QUALITY', 'NOT_RUN', 'needs the picture decoded in a browser (scripts/image-quality-measure.mjs)'));
  } else {
    const flat = pixels.stdLuma < 4 || pixels.distinctColors < 8;
    checks.push(check('NOT_BLANK_OR_FLAT', 'QUALITY', flat ? 'FAIL' : 'PASS', `luma std ${pixels.stdLuma.toFixed(1)}, ${pixels.distinctColors} distinct colours, edge share ${(pixels.edgeShare * 100).toFixed(1)}%`));
    if (info && (pixels.width !== info.width || pixels.height !== info.height)) checks.push(check('DECODES_AT_THE_SIZE_IT_CLAIMS', 'TECHNICAL', 'FAIL', `header ${info.width}x${info.height}, decoded ${pixels.width}x${pixels.height}`));
  }
  if (expectation.text?.length) {
    if (!text) checks.push(check('TEXT_LEGIBLE_AS_ASKED', 'QUALITY', 'NOT_RUN', 'needs a reader (OCR / vision) to read the picture back; advisory when run'));
    else {
      const read = normalize(text.recognized);
      const missing = expectation.text.filter((t) => !read.includes(normalize(t)));
      checks.push(check('TEXT_LEGIBLE_AS_ASKED', 'QUALITY', missing.length ? 'FAIL' : 'PASS', missing.length ? `not read back: ${missing.join(' | ')} (reader: ${text.engine}, advisory)` : `${expectation.text.length} text(s) read back (reader: ${text.engine}, advisory)`));
    }
  }
  if (expectation.scenario === 'EDIT') {
    if (!expectation.parent) checks.push(check('EDIT_DIFFERS_FROM_PARENT', 'QUALITY', 'NOT_RUN', 'the picture it was edited from was not supplied'));
    else {
      const parent = imageSize(expectation.parent.bytes);
      const same = createHash('sha256').update(bytes).digest('hex') === createHash('sha256').update(expectation.parent.bytes).digest('hex');
      checks.push(check('EDIT_DIFFERS_FROM_PARENT', 'QUALITY', same ? 'FAIL' : 'PASS', same ? 'the "edit" is byte-for-byte the original' : 'the bytes differ from the original'));
      if (parent && info) checks.push(check('EDIT_KEEPS_THE_SHAPE', 'QUALITY', Math.abs(parent.width / parent.height - info.width / info.height) <= 0.03 ? 'PASS' : 'FAIL', `original ${parent.width}x${parent.height}, edit ${info.width}x${info.height}`));
    }
  }
  return { artifact: 'IMAGE', technical: verdict(checks, 'TECHNICAL'), quality: verdict(checks, 'QUALITY'), checks, stats: { bytes: bytes.length, ...(info ? { width: info.width, height: info.height, format: info.extension } : {}) } };
}

// ── video (the MP4 container, read from its own boxes) ─────────────────────────────────────────────────────────────────────────────────────
export interface Mp4Info {
  brand: string;
  durationSec: number | null;
  tracks: Array<{ type: 'video' | 'audio' | 'other'; codec: string; width?: number; height?: number }>;
  width: number | null;
  height: number | null;
  fragmented: boolean;
}

interface Box { type: string; start: number; end: number; header: number }
function* boxes(bytes: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) { if (offset + 16 > end) return; size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return; // a truncated or lying box ends the walk
    yield { type, start: offset, end: offset + size, header };
    offset += size;
  }
}
const find = (bytes: Buffer, parent: { start: number; end: number; header?: number }, type: string): Box | undefined => {
  for (const box of boxes(bytes, parent.start + (parent.header ?? 0), parent.end)) if (box.type === type) return box;
  return undefined;
};

export function parseMp4(bytes: Buffer): Mp4Info | null {
  const top = { start: 0, end: bytes.length };
  const ftyp = find(bytes, top, 'ftyp');
  const moov = find(bytes, top, 'moov');
  if (!ftyp || !moov) return null;
  const brand = bytes.toString('latin1', ftyp.start + ftyp.header, ftyp.start + ftyp.header + 4);
  let durationSec: number | null = null;
  const mvhd = find(bytes, moov, 'mvhd');
  if (mvhd) {
    const p = mvhd.start + mvhd.header; const version = bytes[p];
    const timescale = version === 1 ? bytes.readUInt32BE(p + 20) : bytes.readUInt32BE(p + 12);
    const duration = version === 1 ? Number(bytes.readBigUInt64BE(p + 24)) : bytes.readUInt32BE(p + 16);
    if (timescale > 0 && duration > 0) durationSec = duration / timescale;
  }
  const tracks: Mp4Info['tracks'] = [];
  for (const trak of boxes(bytes, moov.start + moov.header, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = find(bytes, trak, 'mdia'); const hdlr = mdia && find(bytes, mdia, 'hdlr');
    const handler = hdlr ? bytes.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) : '';
    const type: 'video' | 'audio' | 'other' = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';
    const minf = mdia && find(bytes, mdia, 'minf'); const stbl = minf && find(bytes, minf, 'stbl'); const stsd = stbl && find(bytes, stbl, 'stsd');
    const codec = stsd && stsd.end - stsd.start >= stsd.header + 16 ? bytes.toString('latin1', stsd.start + stsd.header + 12, stsd.start + stsd.header + 16) : 'unknown';
    const tkhd = find(bytes, trak, 'tkhd');
    let width: number | undefined; let height: number | undefined;
    if (tkhd && type === 'video') { const v = bytes[tkhd.start + tkhd.header]; const base = tkhd.start + tkhd.header + (v === 1 ? 88 : 76); if (base + 8 <= tkhd.end) { width = Math.round(bytes.readUInt32BE(base) / 65536); height = Math.round(bytes.readUInt32BE(base + 4) / 65536); } }
    tracks.push({ type, codec, ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }
  const video = tracks.find((t) => t.type === 'video');
  return { brand, durationSec, tracks, width: video?.width ?? null, height: video?.height ?? null, fragmented: Boolean(find(bytes, moov, 'mvex')) };
}

export interface VideoExpectation {
  durationSec?: { min: number; max: number };
  aspectRatio?: '16:9' | '9:16' | '1:1';
  aspectTolerance?: number;
  minWidth?: number;
  requireAudio?: boolean;
}
/** Measured by a real player (a <video> element in Chrome): the file loads, plays, and its clock advances. */
export interface VideoPlaybackFacts { canPlay: boolean; clockAdvanced: boolean; videoWidth: number; videoHeight: number; duration: number; engine: string }
const KNOWN_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);

export function evaluateVideo(bytes: Buffer, expectation: VideoExpectation, playback?: VideoPlaybackFacts): QualityReport {
  const checks: QualityCheck[] = [];
  const mp4 = parseMp4(bytes);
  checks.push(check('IS_AN_MP4_WITH_A_MOVIE_BOX', 'TECHNICAL', mp4 ? 'PASS' : 'FAIL', mp4 ? `brand ${mp4.brand}` : 'no ftyp / moov box: not an MP4 a player can open'));
  if (mp4) {
    const video = mp4.tracks.find((t) => t.type === 'video');
    checks.push(check('HAS_A_VIDEO_TRACK_WITH_A_KNOWN_CODEC', 'TECHNICAL', video && KNOWN_VIDEO_CODECS.has(video.codec) ? 'PASS' : 'FAIL', video ? `codec ${video.codec}` : 'no video track'));
    if (expectation.durationSec) {
      const d = mp4.durationSec;
      checks.push(check('DURATION_AS_ASKED', 'QUALITY', d !== null && d >= expectation.durationSec.min && d <= expectation.durationSec.max ? 'PASS' : 'FAIL', `${d === null ? 'unknown' : d.toFixed(2)} s, ${expectation.durationSec.min}-${expectation.durationSec.max} s asked`));
    }
    if (expectation.aspectRatio) {
      const want = expectation.aspectRatio === '16:9' ? 16 / 9 : expectation.aspectRatio === '9:16' ? 9 / 16 : 1;
      const got = mp4.width && mp4.height ? mp4.width / mp4.height : null;
      checks.push(check('ASPECT_RATIO_AS_ASKED', 'QUALITY', got !== null && Math.abs(got - want) / want <= (expectation.aspectTolerance ?? 0.03) ? 'PASS' : 'FAIL', `${mp4.width}x${mp4.height}, ${expectation.aspectRatio} asked`));
    }
    if (expectation.minWidth) checks.push(check('WIDTH_AT_LEAST_ASKED', 'QUALITY', (mp4.width ?? 0) >= expectation.minWidth ? 'PASS' : 'FAIL', `${mp4.width} px, at least ${expectation.minWidth} asked`));
    if (expectation.requireAudio) checks.push(check('HAS_AUDIO_AS_ASKED', 'QUALITY', mp4.tracks.some((t) => t.type === 'audio') ? 'PASS' : 'FAIL', mp4.tracks.some((t) => t.type === 'audio') ? 'an audio track' : 'no audio track'));
  }
  if (!playback) {
    checks.push(check('PLAYS_IN_A_REAL_PLAYER', 'TECHNICAL', 'NOT_RUN', 'needs a real player (Chrome with H.264) - the bundled Chromium cannot play H.264'));
    checks.push(check('PLAYBACK_CLOCK_ADVANCES', 'QUALITY', 'NOT_RUN', 'needs a real player'));
  } else {
    checks.push(check('PLAYS_IN_A_REAL_PLAYER', 'TECHNICAL', playback.canPlay ? 'PASS' : 'FAIL', `${playback.engine}: ${playback.videoWidth}x${playback.videoHeight}, ${playback.duration.toFixed(2)} s`));
    checks.push(check('PLAYBACK_CLOCK_ADVANCES', 'QUALITY', playback.clockAdvanced ? 'PASS' : 'FAIL', playback.clockAdvanced ? 'the playback position moved' : 'the playback position never moved'));
  }
  // scene consistency, motion quality, what the clip shows: human review - listed so a reviewer is pointed at it, never decided here
  checks.push(check('SCENE_CONSISTENCY_AND_CONTENT', 'QUALITY', 'NOT_RUN', 'human review (or a vision model, advisory): not decidable from the file'));
  return { artifact: 'VIDEO', technical: verdict(checks, 'TECHNICAL'), quality: verdict(checks, 'QUALITY'), checks, stats: { bytes: bytes.length, ...(mp4 ? { brand: mp4.brand, durationSec: mp4.durationSec ?? 'unknown', width: mp4.width ?? 'unknown', height: mp4.height ?? 'unknown', tracks: mp4.tracks.map((t) => `${t.type}:${t.codec}`).join(',') } : {}) } };
}
