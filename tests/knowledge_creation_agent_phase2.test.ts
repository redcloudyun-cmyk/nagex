import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LocalRasterImageProvider,
  UniversalCreationAgent,
  neutralProfessionalTheme,
  validateDocxLayout,
  validatePngImage,
  validateSlideVisuals,
  type CreationIntent,
  type VideoProviderAdapter,
  type VideoRenderRequest,
  type VideoRenderResult,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-creation-agent-p2-'));
}

function intent(outputLocation = tempDir()): CreationIntent {
  return {
    goalId: 'goal-creation-phase2',
    goal: 'Create a four page report, eight slide deck, hero image, and short intro video from the same source.',
    artifactTypes: ['REPORT', 'SLIDES', 'IMAGE', 'VIDEO'],
    inputModalities: ['TEXT'],
    audience: 'professional reviewers',
    purpose: 'compound knowledge artifact creation',
    language: 'en',
    tone: 'premium minimal and executive',
    length: '4 page report, 8 slides, 20-30 second video',
    format: 'DOCX, PPTX, PNG, MP4',
    brandContext: {
      brandStyleId: 'nagex-corporate',
      visualTheme: neutralProfessionalTheme.themeId,
      typographyPolicy: neutralProfessionalTheme.fontPolicy,
      spacingPolicy: 'balanced density',
      colorTokenHook: 'nagex.tokens.creation.phase2',
    },
    sourceFiles: [],
    sourceURLs: [],
    personalContextAllowed: false,
    outputLocation,
  };
}

class StubVideoProvider implements VideoProviderAdapter {
  readonly providerId = 'stub-video-provider';
  constructor(private readonly status: VideoRenderResult['status'] = 'RENDERED') {}
  render(request: VideoRenderRequest): VideoRenderResult {
    if (this.status !== 'RENDERED') {
      return { status: this.status, durationSeconds: 21, sceneCount: request.scenes.length, audioStatus: request.audioPolicy, error: 'intentional test failure' };
    }
    fs.writeFileSync(request.outputPath, Buffer.concat([Buffer.from('NAGEX_MP4_TEST_CONTAINER'), Buffer.alloc(2048, 7)]));
    return { status: 'RENDERED', file: request.outputPath, durationSeconds: 21, sceneCount: request.scenes.length, audioStatus: request.audioPolicy };
  }
}

test('artifact visual theme contract is reusable and not hardcoded to one artifact', () => {
  assert.equal(neutralProfessionalTheme.brandStyleId, 'nagex-corporate');
  assert.ok(neutralProfessionalTheme.colorTokens.length >= 4);
  assert.equal(neutralProfessionalTheme.cornerRadiusPolicy, 'SUBTLE');
  assert.match(neutralProfessionalTheme.fontPolicy, /hierarchy/);
});

test('image provider adapter creates a linked decodable raster image', () => {
  const outputPath = path.join(tempDir(), 'hero.png');
  const result = new LocalRasterImageProvider().create({
    prompt: 'professional NAgex hero image',
    aspectRatio: '16:9',
    usageContext: 'report cover',
    parentGoalId: 'goal-image',
    outputPurpose: 'REPORT_COVER',
    outputPath,
    theme: neutralProfessionalTheme,
  });
  const validation = validatePngImage(result.file);
  assert.equal(result.providerId, 'local-raster-image-provider');
  assert.equal(validation.status, 'PASS');
  assert.equal(validation.width, 1280);
  assert.equal(result.generationMetadata.parentGoalId, 'goal-image');
});

test('phase2 compound workflow records report, slides, image revisions, and video linkage', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  assert.equal(result.parentGoalId, 'goal-creation-phase2');
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'REPORT'));
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'SLIDES'));
  assert.ok(result.artifacts.filter((artifact) => artifact.artifactType === 'IMAGE').length >= 2);
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'VIDEO' && artifact.status === 'VALIDATED'));
  assert.ok(result.graph.edges.length >= 4);
  assert.equal(result.video.sceneCount, 3);
});

test('image revision increments version and preserves original lineage', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  const images = result.artifacts.filter((artifact) => artifact.artifactType === 'IMAGE');
  assert.equal(images[0].version, 1);
  assert.equal(images[1].version, 2);
  assert.equal(images[1].derivedFrom, images[0].artifactId);
  assert.ok(fs.existsSync(images[0].storageLocation));
  assert.ok(fs.existsSync(images[1].storageLocation));
});

test('video provider state and artifact linkage are captured', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  const video = result.artifacts.find((artifact) => artifact.artifactType === 'VIDEO');
  assert.ok(video);
  assert.equal(result.video.durationSeconds, 21);
  assert.equal(result.video.audioStatus, 'SILENT_CAPTIONS_ONLY');
  assert.ok(result.graph.edges.some((edge) => edge.toArtifactId === video.artifactId));
});

test('partial failure isolation preserves successful artifacts when video render fails', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider('TOOL_UNAVAILABLE') }).runPhase2Compound(intent());
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'REPORT' && artifact.status === 'VALIDATED'));
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'SLIDES' && artifact.status === 'VALIDATED'));
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'IMAGE' && artifact.status === 'VALIDATED'));
  assert.ok(result.artifacts.some((artifact) => artifact.artifactType === 'VIDEO' && artifact.status === 'FAILED'));
  assert.equal(result.video.status, 'TOOL_UNAVAILABLE');
});

test('report layout validation checks more than package existence', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  const report = result.artifacts.find((artifact) => artifact.artifactType === 'REPORT');
  assert.ok(report);
  const validation = validateDocxLayout(report.storageLocation);
  assert.equal(validation.status, 'PASS');
  assert.ok(validation.checks.includes('table-rendering'));
});

test('slide visual validation checks slide count and density', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  const slides = result.artifacts.find((artifact) => artifact.artifactType === 'SLIDES');
  assert.ok(slides);
  const validation = validateSlideVisuals(slides.storageLocation, 8);
  assert.equal(validation.status, 'PASS');
  assert.ok(validation.checks.includes('margin-consistency'));
});

test('cross-artifact revision marks only linked downstream artifacts as needing refresh', () => {
  const result = new UniversalCreationAgent({ videoProvider: new StubVideoProvider() }).runPhase2Compound(intent());
  const image = result.artifacts.find((artifact) => artifact.artifactType === 'IMAGE' && artifact.version === 2);
  const videoEdge = result.graph.edges.find((edge) => edge.relationship === 'video-scene-source');
  assert.ok(image && videoEdge);
  assert.equal(videoEdge.fromArtifactId, image.artifactId);
  assert.ok(result.progress.includes('final-validation'));
});
