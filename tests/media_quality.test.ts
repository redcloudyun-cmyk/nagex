// Outcome Quality for images and videos (C3 / C4): what can be CHECKED about a picture or a clip a provider returned, without asking a model whether it likes it - and what cannot, said as NOT_RUN.
//   IMAGE: the bytes are a PNG / JPEG (not an error page saved as .png), the size and aspect ratio are what was asked, the picture is not blank (pixel facts), requested text is legible (advisory reader),
//          an EDIT differs from its original and keeps its shape.
//   VIDEO: the bytes are an MP4 whose own boxes say what it holds (duration, frame size, video codec, audio); a real player confirms it plays - without that, NOT_RUN.
// No real image or video was generated for this suite: the providers are BLOCKED (quota exhausted / no credentials) and the evidence document says so. The MP4 here is assembled box by box
// to the ISO base media format, so the PARSER is certified; it is not a clip a player has seen.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateImage, evaluateVideo, parseMp4, type ImagePixelFacts } from '../src/creation/quality/media-quality.js';
import type { QualityReport } from '../src/creation/quality/outcome-quality.js';
import { jpegHeader, makeBarsPng, makePng } from './_png.js';

const status = (report: QualityReport, id: string) => report.checks.find((c) => c.id === id)?.status;
const detail = (report: QualityReport, id: string) => report.checks.find((c) => c.id === id)?.detail ?? '';

describe('images', () => {
  const png = makeBarsPng(1600, 900, [0.4, 0.8, 0.6]);
  const pixels = (over: Partial<ImagePixelFacts> = {}): ImagePixelFacts => ({ width: 1600, height: 900, meanLuma: 200, stdLuma: 60, distinctColors: 1200, edgeShare: 0.05, ...over });

  it('a real picture of the size and shape asked for passes what the bytes can say; what needs pixels or a reader is NOT_RUN, so the verdict is PARTIAL', () => {
    const report = evaluateImage(png, { minWidth: 1024, minHeight: 576, aspectRatio: '16:9', text: ['NAgex'] });
    assert.equal(status(report, 'FORMAT_IS_PNG_OR_JPEG'), 'PASS');
    assert.equal(status(report, 'RESOLUTION_AT_LEAST_ASKED'), 'PASS');
    assert.equal(status(report, 'ASPECT_RATIO_AS_ASKED'), 'PASS');
    assert.equal(status(report, 'NOT_BLANK_OR_FLAT'), 'NOT_RUN');
    assert.equal(status(report, 'TEXT_LEGIBLE_AS_ASKED'), 'NOT_RUN');
    assert.deepEqual([report.technical, report.quality], ['PASS', 'PARTIAL']);
  });

  it('bytes that are not a picture fail the file, whatever they were saved as: an HTML error body, a GIF, a WebP, nothing', () => {
    for (const bytes of [Buffer.from('<html><body>429 Too Many Requests</body></html>'), Buffer.from('GIF89a......'), Buffer.from('RIFF....WEBPVP8 '), Buffer.alloc(0)]) {
      const report = evaluateImage(bytes, { minWidth: 100 });
      assert.equal(status(report, 'FORMAT_IS_PNG_OR_JPEG'), 'FAIL');
      assert.equal(report.technical, 'FAIL');
    }
  });

  it('too small, or the wrong shape, fails; a JPEG is read like a PNG', () => {
    assert.equal(status(evaluateImage(makePng(640, 360), { minWidth: 1024, minHeight: 576 }), 'RESOLUTION_AT_LEAST_ASKED'), 'FAIL');
    assert.equal(status(evaluateImage(makePng(1000, 1000), { aspectRatio: '16:9' }), 'ASPECT_RATIO_AS_ASKED'), 'FAIL');
    assert.equal(status(evaluateImage(makePng(1000, 1000), { aspectRatio: '1:1' }), 'ASPECT_RATIO_AS_ASKED'), 'PASS');
    assert.equal(status(evaluateImage(makePng(1024, 700), { aspectRatio: '3:2', aspectTolerance: 0.05 }), 'ASPECT_RATIO_AS_ASKED'), 'PASS', '1.463 vs 1.5 within 5%');
    const jpeg = evaluateImage(jpegHeader(1280, 720), { aspectRatio: '16:9', minWidth: 1280 });
    assert.deepEqual([status(jpeg, 'FORMAT_IS_PNG_OR_JPEG'), status(jpeg, 'ASPECT_RATIO_AS_ASKED'), status(jpeg, 'RESOLUTION_AT_LEAST_ASKED')], ['PASS', 'PASS', 'PASS']);
  });

  it('a blank or flat picture fails (pixel facts); a picture with detail passes; a decode that disagrees with the header fails', () => {
    assert.equal(status(evaluateImage(png, {}, pixels({ stdLuma: 0.2, distinctColors: 1, edgeShare: 0 })), 'NOT_BLANK_OR_FLAT'), 'FAIL');
    assert.equal(status(evaluateImage(png, {}, pixels({ stdLuma: 30, distinctColors: 3 })), 'NOT_BLANK_OR_FLAT'), 'FAIL', 'three colours is a fill, not a picture');
    const ok = evaluateImage(png, {}, pixels());
    assert.equal(status(ok, 'NOT_BLANK_OR_FLAT'), 'PASS');
    assert.equal(ok.quality, 'PASS');
    const lying = evaluateImage(png, {}, pixels({ width: 800, height: 450 }));
    assert.equal(status(lying, 'DECODES_AT_THE_SIZE_IT_CLAIMS'), 'FAIL');
    assert.equal(lying.technical, 'FAIL');
  });

  it('requested text must be read back - ignoring spaces, case and width variants - and the reader is named as ADVISORY', () => {
    const want = { text: ['NAgex 2026', '승인 후 실행'] };
    const found = evaluateImage(png, want, pixels(), { recognized: 'nagex  2026\n승인 후   실행', engine: 'test-reader' });
    assert.equal(status(found, 'TEXT_LEGIBLE_AS_ASKED'), 'PASS');
    assert.match(detail(found, 'TEXT_LEGIBLE_AS_ASKED'), /advisory/);
    const missing = evaluateImage(png, want, pixels(), { recognized: 'NAgex 2O26', engine: 'test-reader' });
    assert.equal(status(missing, 'TEXT_LEGIBLE_AS_ASKED'), 'FAIL');
    assert.match(detail(missing, 'TEXT_LEGIBLE_AS_ASKED'), /NAgex 2026 \| 승인 후 실행/);
  });

  it('an EDIT must differ from its original and keep its shape; the same bytes handed back as an "edit" fail', () => {
    const original = makePng(800, 450);
    const edited = makeBarsPng(800, 450, [0.5, 0.7]);
    const ok = evaluateImage(edited, { scenario: 'EDIT', parent: { bytes: original } }, pixels({ width: 800, height: 450 }));
    assert.deepEqual([status(ok, 'EDIT_DIFFERS_FROM_PARENT'), status(ok, 'EDIT_KEEPS_THE_SHAPE')], ['PASS', 'PASS']);
    assert.equal(status(evaluateImage(original, { scenario: 'EDIT', parent: { bytes: original } }), 'EDIT_DIFFERS_FROM_PARENT'), 'FAIL');
    assert.equal(status(evaluateImage(makeBarsPng(450, 800, [0.5]), { scenario: 'EDIT', parent: { bytes: original } }), 'EDIT_KEEPS_THE_SHAPE'), 'FAIL', 'a landscape picture came back portrait');
    assert.equal(status(evaluateImage(edited, { scenario: 'EDIT' }), 'EDIT_DIFFERS_FROM_PARENT'), 'NOT_RUN', 'no original supplied');
    assert.equal(status(evaluateImage(edited, { scenario: 'CREATE' }), 'EDIT_DIFFERS_FROM_PARENT'), undefined, 'a new picture has no original to differ from');
  });
});

// ── an MP4 assembled to the ISO base media format ───────────────────────────────────────────────────────────────────────────────────────────
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type: string, ...children: Buffer[]) => { const body = Buffer.concat(children); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const fullBox = (type: string, payload: Buffer, version = 0) => box(type, Buffer.from([version, 0, 0, 0]), payload);
function mvhd(timescale: number, duration: number): Buffer { return fullBox('mvhd', Buffer.concat([u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80)])); }
function tkhd(width: number, height: number): Buffer { return fullBox('tkhd', Buffer.concat([u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(36), u32(width * 65536), u32(height * 65536)])); }
function trak(handler: 'vide' | 'soun', codec: string, size?: [number, number]): Buffer {
  const hdlr = fullBox('hdlr', Buffer.concat([u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12), Buffer.from('h\0')]));
  const stsd = fullBox('stsd', Buffer.concat([u32(1), box(codec, Buffer.alloc(78))]));
  return box('trak', tkhd(size?.[0] ?? 0, size?.[1] ?? 0), box('mdia', hdlr, box('minf', box('stbl', stsd))));
}
function mp4(opts: { seconds?: number; size?: [number, number]; codec?: string; audio?: boolean; fragmented?: boolean } = {}): Buffer {
  const { seconds = 5, size = [1280, 720], codec = 'avc1', audio = false, fragmented = false } = opts;
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2avc1mp41', 'latin1')), box('moov', mvhd(1000, Math.round(seconds * 1000)), trak('vide', codec, size), ...(audio ? [trak('soun', 'mp4a')] : []), ...(fragmented ? [box('mvex')] : [])), box('mdat', Buffer.alloc(32))]);
}

describe('videos', () => {
  it('the container is read from its own boxes: brand, duration, frame size, tracks with their codecs, fragmentation', () => {
    const info = parseMp4(mp4({ seconds: 8.5, size: [1920, 1080], audio: true, fragmented: true }))!;
    assert.equal(info.brand, 'isom');
    assert.equal(info.durationSec, 8.5);
    assert.deepEqual([info.width, info.height], [1920, 1080]);
    assert.deepEqual(info.tracks.map((t) => `${t.type}:${t.codec}`), ['video:avc1', 'audio:mp4a']);
    assert.equal(info.fragmented, true);
    assert.equal(parseMp4(Buffer.from('not a movie at all')), null);
    assert.equal(parseMp4(Buffer.alloc(0)), null);
    assert.equal(parseMp4(mp4().subarray(0, 40)), null, 'truncated before the movie box ends');
  });

  it('a clip of the length, shape and size asked for passes what its header can say; the player and the scene are NOT_RUN, so the verdict is PARTIAL', () => {
    const report = evaluateVideo(mp4({ seconds: 5, size: [1280, 720], audio: true }), { durationSec: { min: 4, max: 6 }, aspectRatio: '16:9', minWidth: 1280, requireAudio: true });
    for (const id of ['IS_AN_MP4_WITH_A_MOVIE_BOX', 'HAS_A_VIDEO_TRACK_WITH_A_KNOWN_CODEC', 'DURATION_AS_ASKED', 'ASPECT_RATIO_AS_ASKED', 'WIDTH_AT_LEAST_ASKED', 'HAS_AUDIO_AS_ASKED']) assert.equal(status(report, id), 'PASS', `${id}: ${detail(report, id)}`);
    for (const id of ['PLAYS_IN_A_REAL_PLAYER', 'PLAYBACK_CLOCK_ADVANCES', 'SCENE_CONSISTENCY_AND_CONTENT']) assert.equal(status(report, id), 'NOT_RUN', id);
    assert.deepEqual([report.technical, report.quality], ['PARTIAL', 'PARTIAL']);
  });

  it('wrong length, wrong shape, too narrow, no audio when audio was asked, an unknown codec and a non-MP4 each fail', () => {
    assert.equal(status(evaluateVideo(mp4({ seconds: 12 }), { durationSec: { min: 4, max: 6 } }), 'DURATION_AS_ASKED'), 'FAIL');
    assert.equal(status(evaluateVideo(mp4({ size: [720, 1280] }), { aspectRatio: '16:9' }), 'ASPECT_RATIO_AS_ASKED'), 'FAIL');
    assert.equal(status(evaluateVideo(mp4({ size: [720, 1280] }), { aspectRatio: '9:16' }), 'ASPECT_RATIO_AS_ASKED'), 'PASS');
    assert.equal(status(evaluateVideo(mp4({ size: [640, 360] }), { minWidth: 1280 }), 'WIDTH_AT_LEAST_ASKED'), 'FAIL');
    assert.equal(status(evaluateVideo(mp4({ audio: false }), { requireAudio: true }), 'HAS_AUDIO_AS_ASKED'), 'FAIL');
    assert.equal(status(evaluateVideo(mp4({ codec: 'zzzz' }), {}), 'HAS_A_VIDEO_TRACK_WITH_A_KNOWN_CODEC'), 'FAIL');
    const notVideo = evaluateVideo(Buffer.from('<html>error</html>'), { durationSec: { min: 1, max: 2 } });
    assert.equal(status(notVideo, 'IS_AN_MP4_WITH_A_MOVIE_BOX'), 'FAIL');
    assert.equal(notVideo.technical, 'FAIL');
  });

  it('what a real player measured decides: it plays and the clock moves - or it does not', () => {
    const clip = mp4({ seconds: 5 });
    const played = evaluateVideo(clip, {}, { canPlay: true, clockAdvanced: true, videoWidth: 1280, videoHeight: 720, duration: 5, engine: 'Chrome 155' });
    assert.deepEqual([status(played, 'PLAYS_IN_A_REAL_PLAYER'), status(played, 'PLAYBACK_CLOCK_ADVANCES')], ['PASS', 'PASS']);
    const frozen = evaluateVideo(clip, {}, { canPlay: true, clockAdvanced: false, videoWidth: 1280, videoHeight: 720, duration: 5, engine: 'Chrome 155' });
    assert.equal(status(frozen, 'PLAYBACK_CLOCK_ADVANCES'), 'FAIL');
    const broken = evaluateVideo(clip, {}, { canPlay: false, clockAdvanced: false, videoWidth: 0, videoHeight: 0, duration: 0, engine: 'Chrome 155' });
    assert.equal(broken.technical, 'FAIL');
  });

  it('the scene - what the clip shows, whether it holds together from shot to shot - is never decided from the file: it stays NOT_RUN even when everything else passed', () => {
    const report = evaluateVideo(mp4(), { durationSec: { min: 1, max: 10 } }, { canPlay: true, clockAdvanced: true, videoWidth: 1280, videoHeight: 720, duration: 5, engine: 'Chrome 155' });
    assert.equal(status(report, 'SCENE_CONSISTENCY_AND_CONTENT'), 'NOT_RUN');
    assert.equal(report.quality, 'PARTIAL', 'never PASS without a human (or an advisory vision model) looking');
  });
});
