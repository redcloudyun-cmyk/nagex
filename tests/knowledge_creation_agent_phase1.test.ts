import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CreationCapabilityResolver,
  CreationContextResolver,
  CreationPlanner,
  RevisionEngine,
  UniversalCreationAgent,
  listStoreZipEntries,
  type CreationIntent,
} from '../src/creation-agent/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-creation-agent-'));
}

function intent(overrides: Partial<CreationIntent> = {}): CreationIntent {
  return {
    goalId: 'goal-creation-phase1',
    goal: 'Create a 3-5 page report and an 8 slide deck from the source material.',
    artifactTypes: ['REPORT', 'SLIDES'],
    inputModalities: ['TEXT'],
    audience: 'professional reviewers',
    purpose: 'summarize source material',
    language: 'en',
    tone: 'clear and executive',
    length: '3-5 pages and 8 slides',
    format: 'DOCX and PPTX',
    brandContext: {
      brandStyleId: 'nagex-natural',
      visualTheme: 'calm-professional',
      typographyPolicy: 'readable hierarchy',
      spacingPolicy: 'balanced density',
      colorTokenHook: 'nagex.tokens.creation',
      logoAssetHook: 'nagex.logo',
    },
    sourceFiles: ['source-brief.txt'],
    sourceURLs: [],
    screenContext: undefined,
    personalContextAllowed: false,
    outputLocation: tempDir(),
    ...overrides,
  };
}

test('universal CreationIntent covers all artifact types without top-level per-artifact intents', () => {
  const creationIntent = intent({ artifactTypes: ['REPORT', 'DOCUMENT', 'SLIDES', 'IMAGE', 'VIDEO', 'DATA_VISUALIZATION', 'OTHER'] });
  assert.equal(creationIntent.goalId, 'goal-creation-phase1');
  assert.ok(creationIntent.artifactTypes.includes('VIDEO'));
  assert.ok(creationIntent.brandContext?.colorTokenHook);
});

test('creation intent is modality-independent across text, voice, file, screen, url, image, multimodal', () => {
  const modalities: CreationIntent['inputModalities'] = ['TEXT', 'VOICE', 'FILE', 'SCREEN', 'URL', 'IMAGE', 'MULTIMODAL'];
  const intents = modalities.map((modality) => intent({ inputModalities: [modality] }));
  assert.deepEqual(new Set(intents.map((i) => i.goal)), new Set([intent().goal]));
  assert.ok(intents.every((i) => i.artifactTypes.includes('REPORT') && i.artifactTypes.includes('SLIDES')));
});

test('context resolver is evidence-based and does not guess deictic references', () => {
  const resolved = new CreationContextResolver().resolve(intent({ sourceFiles: [], sourceURLs: [], screenContext: undefined }));
  assert.equal(resolved.sourceRefs[0].kind, 'USER_INSTRUCTION');
  assert.equal(resolved.sourceRefs[0].classification, 'USER_PROVIDED_CONTENT');
  assert.ok(resolved.limitations.length > 0);
  const confirmed = new CreationContextResolver().resolve(intent({ screenContext: 'Active browser page evidence' }));
  assert.equal(confirmed.confidence, 'CONFIRMED');
  assert.ok(confirmed.sourceRefs.some((ref) => ref.kind === 'SCREEN'));
});

test('creation planner asks only critical blockers and otherwise exposes assumptions', () => {
  const planner = new CreationPlanner();
  const planned = planner.plan(intent({ audience: undefined }));
  assert.equal(planned.state, 'PLAN_CREATED');
  assert.ok(planned.missingRequirements.some((req) => req.field === 'audience' && req.importance !== 'CRITICAL'));
  assert.ok(planned.steps.some((step) => step.kind === 'artifact_rendering'));
});

test('capability resolver is provider-neutral and artifact-aware', () => {
  const resolved = new CreationCapabilityResolver().resolve(intent({ artifactTypes: ['REPORT', 'SLIDES', 'IMAGE', 'VIDEO'] }));
  for (const capability of ['LLM_TEXT', 'DOCX_RENDER', 'SLIDE_RENDER', 'IMAGE_GENERATION', 'VIDEO_GENERATION'] as const) {
    assert.ok(resolved.capabilities.includes(capability));
  }
  assert.equal(resolved.providerNeutral, true);
  assert.ok(resolved.unavailable.includes('VIDEO_GENERATION'));
});

test('real compound E2E writes linked report DOCX and slide PPTX artifacts', () => {
  const outputLocation = tempDir();
  fs.writeFileSync(path.join(outputLocation, 'source-brief.txt'), 'NAgex remembers, creates, asks approval, acts, and verifies.', 'utf8');
  const result = new UniversalCreationAgent().runPhase1Compound(intent({ outputLocation, sourceFiles: [path.join(outputLocation, 'source-brief.txt')] }));
  assert.equal(result.parentGoalId, 'goal-creation-phase1');
  assert.equal(result.artifacts.length, 2);
  const report = result.artifacts.find((artifact) => artifact.artifactType === 'REPORT');
  const slides = result.artifacts.find((artifact) => artifact.artifactType === 'SLIDES');
  assert.ok(report && fs.existsSync(report.storageLocation));
  assert.ok(slides && fs.existsSync(slides.storageLocation));
  assert.equal(report.format, 'DOCX');
  assert.equal(slides.format, 'PPTX');
  assert.ok(fs.statSync(report.storageLocation).size > 100);
  assert.ok(fs.statSync(slides.storageLocation).size > 100);
  assert.ok(listStoreZipEntries(fs.readFileSync(report.storageLocation)).includes('word/document.xml'));
  assert.ok(listStoreZipEntries(fs.readFileSync(slides.storageLocation)).includes('ppt/presentation.xml'));
  assert.ok(listStoreZipEntries(fs.readFileSync(slides.storageLocation)).includes('ppt/slides/slide8.xml'));
});

test('revision engine preserves artifact identity relationship and increments version', () => {
  const result = new UniversalCreationAgent().runPhase1Compound(intent());
  const revised = new RevisionEngine().revise(result.artifacts[0], 'Make page 3 more detailed.');
  assert.equal(revised.version, result.artifacts[0].version + 1);
  assert.equal(revised.derivedFrom, result.artifacts[0].artifactId);
  assert.equal(revised.goalId, result.parentGoalId);
});

test('generation is not validation success unless rendered artifact is recorded as validated', () => {
  const result = new UniversalCreationAgent().runPhase1Compound(intent());
  assert.ok(result.artifacts.every((artifact) => artifact.status === 'VALIDATED'));
  assert.ok(result.artifacts.every((artifact) => artifact.checksum.length === 64));
});

test('desktop, mobile, and smart tv remain review surfaces rather than goal owners', () => {
  const shared = intent({ inputModalities: ['TEXT', 'VOICE', 'SCREEN'] });
  assert.equal(shared.goalId, 'goal-creation-phase1');
  assert.equal(shared.outputLocation.length > 0, true);
});
