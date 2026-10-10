import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BuiltInAviVideoProvider,
  LocalRasterImageProvider,
  MediaProductionCertRunner,
  validatePngImage,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-media-cert-'));
}

test('real image adapter contract supports create, edit, and variation', () => {
  const dir = tempDir();
  const provider = new LocalRasterImageProvider();
  assert.equal(typeof provider.create, 'function');
  assert.equal(typeof provider.edit, 'function');
  assert.equal(typeof provider.variation, 'function');
  assert.equal(provider.providerId.length > 0, true);
  const image = provider.create({
    prompt: 'data professional hero',
    aspectRatio: '16:9',
    usageContext: 'test',
    parentGoalId: 'goal-media',
    outputPurpose: 'SLIDE_HERO',
    outputPath: path.join(dir, 'image.png'),
    theme: { themeId: 't', brandStyleId: 'DATA_PROFESSIONAL', fontPolicy: 'readable', colorTokens: ['#14213d', '#2a9d8f', '#f4f7f5'], spacingScale: [8], cornerRadiusPolicy: 'SUBTLE', imageStyle: 'structured', chartStyle: 'data', density: 'BALANCED', tone: 'credible' },
  });
  assert.equal(validatePngImage(image.file).status, 'PASS');
});

test('media cert records image lineage and versioning', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  assert.equal(result.image.version, 1);
  assert.equal(result.imageRevision.version, 2);
  assert.deepEqual(result.imageRevision.derivedFrom, [result.image.artifactId]);
  assert.ok(fs.existsSync(result.image.path));
  assert.ok(fs.existsSync(result.imageRevision.path));
});

test('built-in video provider writes a real AVI container', () => {
  const file = path.join(tempDir(), 'test.avi');
  const frame = Buffer.alloc(160 * 90 * 3, 80);
  new BuiltInAviVideoProvider().render({ outputPath: file, frames: [frame, frame, frame], width: 160, height: 90, fps: 1 });
  const header = fs.readFileSync(file).subarray(0, 12).toString('ascii');
  assert.equal(header.slice(0, 4), 'RIFF');
  assert.equal(header.slice(8, 12), 'AVI ');
  assert.equal(fs.statSync(file).size > 1000, true);
});

test('video scene model includes derived artifact links and captions', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.scenes.length, 3);
  assert.ok(manifest.scenes.every((scene: { derivedFromArtifactId: string; caption: string }) => scene.derivedFromArtifactId && scene.caption));
});

test('video artifact lineage and revision preserve original video', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  assert.equal(result.video.version, 1);
  assert.equal(result.videoRevision.version, 2);
  assert.deepEqual(result.videoRevision.derivedFrom, [result.video.artifactId]);
  assert.ok(fs.existsSync(result.video.path));
  assert.ok(fs.existsSync(result.videoRevision.path));
});

test('frame validation extracts start middle and end previews', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  assert.equal(result.videoResult.frameFiles.length, 3);
  for (const file of result.videoResult.frameFiles) assert.equal(validatePngImage(file, 16 / 9).status, 'PASS');
});

test('media failure isolation metadata preserves partial complete behavior', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.failureIsolation.mediaFailureIsolation, true);
  assert.equal(manifest.failureIsolation.partialCompleteSupported, true);
});

test('style propagation and image-to-video dependency are recorded', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  assert.equal(result.image.styleProfileId, 'DATA_PROFESSIONAL');
  assert.equal(result.video.styleProfileId, 'DATA_PROFESSIONAL');
  assert.ok(result.video.derivedFrom.includes(result.imageRevision.artifactId));
});

test('mobile and TV media review compatibility contracts are present', () => {
  const result = new MediaProductionCertRunner().run(tempDir());
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.platforms.mobileImageReviewReady, true);
  assert.equal(manifest.platforms.mobileVideoReviewReady, true);
  assert.equal(manifest.platforms.smartTvMediaReviewCompatible, true);
});
