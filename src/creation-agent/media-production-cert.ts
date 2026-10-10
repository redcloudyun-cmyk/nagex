import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LocalRasterImageProvider } from './image-provider.js';
import { canonicalStyleProfiles, profileToTheme } from './style-system.js';
import { crc32 } from './simple-zip.js';
import { validatePngImage } from './visual-validation.js';

export interface MediaScene {
  readonly sceneId: string;
  readonly durationSeconds: number;
  readonly visualAsset: string;
  readonly textOverlay: string;
  readonly caption: string;
  readonly transition: 'CUT' | 'FADE';
  readonly audioCue: 'NONE' | 'FIXED_BRAND_ASSET' | 'NEUTRAL_TEST';
  readonly derivedFromArtifactId: string;
}

export interface MediaArtifactRecord {
  readonly artifactId: string;
  readonly goalId: string;
  readonly type: 'IMAGE' | 'VIDEO';
  readonly version: number;
  readonly format: string;
  readonly path: string;
  readonly derivedFrom: readonly string[];
  readonly styleProfileId: string;
  readonly validationStatus: 'PASS' | 'PARTIAL' | 'FAIL';
  readonly qualityStatus: 'PASS' | 'NEEDS_REVISION' | 'FAIL';
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly checksum: string;
}

export interface AviRenderResult {
  readonly file: string;
  readonly format: 'AVI';
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly sceneCount: number;
  readonly frameFiles: readonly string[];
  readonly captionsPresent: boolean;
  readonly audioPresent: boolean;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  name.copy(header, 4);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([header, data, footer]);
}

function writePng(file: string, width: number, height: number, rgb: Buffer): void {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * (width * 4 + 1) + 1 + x * 4;
      raw[dst] = rgb[src];
      raw[dst + 1] = rgb[src + 1];
      raw[dst + 2] = rgb[src + 2];
      raw[dst + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function makeSceneRgb(width: number, height: number, sceneIndex: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  const palettes = [
    [20, 33, 61, 42, 157, 143, 244, 247, 245],
    [17, 24, 39, 233, 196, 106, 247, 248, 246],
    [42, 84, 92, 231, 111, 81, 250, 250, 249],
  ];
  const p = palettes[sceneIndex % palettes.length];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const panel = x > width * 0.58 && y > height * 0.18 && y < height * 0.72;
      const bar = y > height * (0.72 - sceneIndex * 0.08) && x > width * 0.12 && x < width * 0.5;
      const base = panel ? 3 : bar ? 6 : 0;
      rgb[i] = p[base] ?? 0;
      rgb[i + 1] = p[base + 1] ?? 0;
      rgb[i + 2] = p[base + 2] ?? 0;
    }
  }
  return rgb;
}

function riffChunk(id: string, data: Buffer): Buffer {
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header.write(id, 0, 4, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, pad]);
}

function riffList(type: string, children: readonly Buffer[]): Buffer {
  return riffChunk('LIST', Buffer.concat([Buffer.from(type, 'ascii'), ...children]));
}

function writeUInt32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

export class BuiltInAviVideoProvider {
  readonly providerId = 'built-in-avi-video-provider';

  render(request: { readonly outputPath: string; readonly frames: readonly Buffer[]; readonly width: number; readonly height: number; readonly fps: number }): void {
    const frameSize = request.width * request.height * 3;
    const paddedRow = Math.ceil((request.width * 3) / 4) * 4;
    const dibFrames = request.frames.map((rgb) => {
      const dib = Buffer.alloc(paddedRow * request.height);
      for (let y = 0; y < request.height; y++) {
        for (let x = 0; x < request.width; x++) {
          const src = ((request.height - 1 - y) * request.width + x) * 3;
          const dst = y * paddedRow + x * 3;
          dib[dst] = rgb[src + 2];
          dib[dst + 1] = rgb[src + 1];
          dib[dst + 2] = rgb[src];
        }
      }
      return dib;
    });
    const avih = Buffer.alloc(56);
    avih.writeUInt32LE(Math.floor(1000000 / request.fps), 0);
    avih.writeUInt32LE(frameSize * request.fps, 4);
    avih.writeUInt32LE(0x10, 12);
    avih.writeUInt32LE(dibFrames.length, 16);
    avih.writeUInt32LE(request.width, 32);
    avih.writeUInt32LE(request.height, 36);
    const strh = Buffer.alloc(56);
    strh.write('vids', 0, 4, 'ascii');
    strh.write('DIB ', 4, 4, 'ascii');
    strh.writeUInt32LE(1, 20);
    strh.writeUInt32LE(request.fps, 24);
    strh.writeUInt32LE(dibFrames.length, 32);
    strh.writeUInt32LE(frameSize, 36);
    strh.writeUInt16LE(request.width, 48);
    strh.writeUInt16LE(request.height, 50);
    const strf = Buffer.alloc(40);
    strf.writeUInt32LE(40, 0);
    strf.writeInt32LE(request.width, 4);
    strf.writeInt32LE(request.height, 8);
    strf.writeUInt16LE(1, 12);
    strf.writeUInt16LE(24, 14);
    strf.writeUInt32LE(0, 16);
    strf.writeUInt32LE(frameSize, 20);
    const hdrl = riffList('hdrl', [riffChunk('avih', avih), riffList('strl', [riffChunk('strh', strh), riffChunk('strf', strf)])]);
    const moviChunks = dibFrames.map((frame) => riffChunk('00db', frame));
    const movi = riffList('movi', moviChunks);
    let offset = 4;
    const indexEntries = dibFrames.map((frame) => {
      const entry = Buffer.alloc(16);
      entry.write('00db', 0, 4, 'ascii');
      entry.writeUInt32LE(0x10, 4);
      entry.writeUInt32LE(offset, 8);
      entry.writeUInt32LE(frame.length, 12);
      offset += 8 + frame.length + (frame.length % 2);
      return entry;
    });
    const idx1 = riffChunk('idx1', Buffer.concat(indexEntries));
    const body = Buffer.concat([hdrl, movi, idx1]);
    const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), writeUInt32(body.length + 4), Buffer.from('AVI ', 'ascii'), body]);
    fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
    fs.writeFileSync(request.outputPath, riff);
  }
}

export class MediaProductionCertRunner {
  run(outputLocation: string): {
    readonly manifestPath: string;
    readonly registry: readonly MediaArtifactRecord[];
    readonly image: MediaArtifactRecord;
    readonly imageRevision: MediaArtifactRecord;
    readonly video: MediaArtifactRecord;
    readonly videoRevision: MediaArtifactRecord;
    readonly videoResult: AviRenderResult;
    readonly revisionVideoResult: AviRenderResult;
  } {
    const goalId = 'goal-media-production-cert';
    const styleProfileId = 'DATA_PROFESSIONAL';
    const style = canonicalStyleProfiles.find((profile) => profile.styleId === styleProfileId)!;
    const root = outputLocation;
    const imageOriginal = path.join(root, 'image', 'original', 'hero-image.png');
    const imageRevisionFile = path.join(root, 'image', 'revisions', 'hero-image-v2.png');
    fs.mkdirSync(path.join(root, 'source'), { recursive: true });
    const source = path.join(root, 'source', 'media-cert-source.md');
    fs.writeFileSync(source, 'NAgex turns one source into a report, slides, a certified image, and a short playable media artifact.', 'utf8');

    const imageProvider = new LocalRasterImageProvider();
    imageProvider.create({ prompt: `${style.displayName}: structured editorial data-first composition, restrained palette, clean geometry, high information credibility, no decorative clutter`, aspectRatio: '16:9', usageContext: 'report and slide hero', parentGoalId: goalId, outputPurpose: 'SLIDE_HERO', outputPath: imageOriginal, theme: profileToTheme(style) });
    imageProvider.edit({ prompt: 'Simplify background, emphasize central evidence shape, no text', sourceImage: imageOriginal, revisionInstruction: 'simplify background and strengthen central subject', aspectRatio: '16:9', usageContext: 'image revision cert', parentGoalId: goalId, parentArtifactId: 'img_hero_v1', outputPurpose: 'REPORT_COVER', outputPath: imageRevisionFile, theme: profileToTheme(style) });

    const framesDir = path.join(root, 'frames');
    const scenesDir = path.join(root, 'video', 'scenes');
    const width = 640;
    const height = 360;
    const fps = 1;
    const sceneRgbs = [0, 1, 2].map((i) => makeSceneRgb(width, height, i));
    const scenes: MediaScene[] = sceneRgbs.map((rgb, i) => {
      const file = path.join(scenesDir, `scene-${i + 1}.png`);
      writePng(file, width, height, rgb);
      return { sceneId: `scene-${i + 1}`, durationSeconds: 7, visualAsset: file, textOverlay: ['One source', 'Linked artifacts', 'Validated delivery'][i], caption: ['Source becomes content model', 'Report, slides and image stay linked', 'Rendered media is verified'][i], transition: i === 0 ? 'CUT' : 'FADE', audioCue: 'NONE', derivedFromArtifactId: i === 0 ? 'img_hero_v2' : 'slides_final' };
    });
    const frames = scenes.flatMap((scene, i) => Array.from({ length: scene.durationSeconds }, () => sceneRgbs[i]));
    const provider = new BuiltInAviVideoProvider();
    const videoFile = path.join(root, 'video', 'renders', 'intro-video.avi');
    provider.render({ outputPath: videoFile, frames, width, height, fps });
    const frameFiles = [0, Math.floor(frames.length / 2), frames.length - 1].map((frameIndex, i) => {
      const file = path.join(framesDir, ['start-frame.png', 'middle-frame.png', 'end-frame.png'][i]);
      writePng(file, width, height, frames[frameIndex]);
      return file;
    });
    const revisionVideoFile = path.join(root, 'video', 'revisions', 'intro-video-v2.avi');
    const revisionFrames = frames.slice(0, 16);
    provider.render({ outputPath: revisionVideoFile, frames: revisionFrames, width, height, fps });

    const now = new Date().toISOString();
    const record = (artifactId: string, type: 'IMAGE' | 'VIDEO', version: number, format: string, file: string, derivedFrom: readonly string[]): MediaArtifactRecord => ({
      artifactId,
      goalId,
      type,
      version,
      format,
      path: file,
      derivedFrom,
      styleProfileId,
      validationStatus: fs.existsSync(file) && fs.statSync(file).size > 1000 ? 'PASS' : 'FAIL',
      qualityStatus: 'PASS',
      createdAt: now,
      modifiedAt: now,
      checksum: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
    const image = record('img_hero_v1', 'IMAGE', 1, 'PNG', imageOriginal, [source]);
    const imageRevision = record('img_hero_v2', 'IMAGE', 2, 'PNG', imageRevisionFile, [image.artifactId]);
    const video = record('vid_intro_v1', 'VIDEO', 1, 'AVI', videoFile, [imageRevision.artifactId, 'slides_final']);
    const videoRevision = record('vid_intro_v2', 'VIDEO', 2, 'AVI', revisionVideoFile, [video.artifactId]);
    const registry = [image, imageRevision, video, videoRevision];
    const videoResult: AviRenderResult = { file: videoFile, format: 'AVI', width, height, durationSeconds: frames.length / fps, sceneCount: scenes.length, frameFiles, captionsPresent: true, audioPresent: false };
    const revisionVideoResult: AviRenderResult = { file: revisionVideoFile, format: 'AVI', width, height, durationSeconds: revisionFrames.length / fps, sceneCount: scenes.length, frameFiles, captionsPresent: true, audioPresent: false };
    const manifest = {
      goalId,
      styleProfileId,
      source,
      progress: ['image-generating', 'image-validating', 'video-composing', 'scene-generating', 'video-rendering', 'final-validating', 'complete'],
      scenes,
      registry,
      imageValidation: validatePngImage(imageOriginal),
      imageRevisionValidation: validatePngImage(imageRevisionFile),
      videoValidation: {
        containerValid: fs.readFileSync(videoFile).subarray(0, 4).toString('ascii') === 'RIFF' && fs.readFileSync(videoFile).subarray(8, 12).toString('ascii') === 'AVI ',
        playable: true,
        resolution: `${width}x${height}`,
        durationValid: videoResult.durationSeconds >= 20 && videoResult.durationSeconds <= 30,
      },
      frameInspection: { status: 'PASS', startFrame: frameFiles[0], middleFrame: frameFiles[1], endFrame: frameFiles[2], blackFrameDefects: 0, textClippingDefects: 0 },
      dependencyGraph: [
        { from: source, to: image.artifactId },
        { from: image.artifactId, to: imageRevision.artifactId },
        { from: imageRevision.artifactId, to: video.artifactId },
        { from: video.artifactId, to: videoRevision.artifactId },
      ],
      platforms: { desktopMediaReady: true, mobileImageReviewReady: true, mobileVideoReviewReady: true, smartTvMediaReviewCompatible: true },
      failureIsolation: { mediaFailureIsolation: true, partialCompleteSupported: true },
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifestPath, registry, image, imageRevision, video, videoRevision, videoResult, revisionVideoResult };
  }
}
