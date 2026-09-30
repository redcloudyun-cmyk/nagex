import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toArtifactUxProjection, type ArtifactRecord } from '../src/artifacts/artifact.types.js';
import { PersonalHomeService } from '../src/home/personal-home.service.js';

const mockImageRecord: ArtifactRecord = {
  artifactId: 'art_123',
  tenantId: 'ten_test',
  ownerId: 'usr_test',
  type: 'IMAGE',
  status: 'COMPLETED',
  title: 'Test Image',
  preview: 'Image generated via prompt',
  sourceType: 'CAPTURE',
  sourceId: 'cap_1',
  openTarget: '/api/v1/creations/images/img_abc',
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
};

const mockPlannedRecord: ArtifactRecord = {
  ...mockImageRecord,
  artifactId: 'art_video',
  type: 'VIDEO',
  openTarget: '',
};

test('A. IMAGE ArtifactRecord -> shared UX projection', () => {
  const proj = toArtifactUxProjection(mockImageRecord);
  assert.equal(proj.previewKind, 'IMAGE');
  assert.equal(proj.previewTarget, '/api/v1/creations/images/img_abc');
  assert.equal(proj.openTarget, '/api/v1/creations/images/img_abc');
});

test('B. artifactId preserved as authoritative identity', () => {
  const proj = toArtifactUxProjection(mockImageRecord);
  assert.equal(proj.artifactId, 'art_123');
  assert.ok(proj.canvasTarget.includes('art_123'));
});

test('C. HOME_API_PROJECTION_TEST: PersonalHomeService injects artifactProjection', async () => {
  const mockArtifactStore = {
    list: () => [mockImageRecord],
    saveCompleted: async () => {},
    get: () => mockImageRecord,
    fail: async () => {}
  } as any;

  const service = new PersonalHomeService({ artifactStore: mockArtifactStore } as any);
  const home = await service.getPersonalHome({ tenantId: 'ten_test', principalId: 'usr_test' } as any);

  const creation = home.recentCreations.find(c => c.id === 'art_123');
  assert.ok(creation, 'Recent creation should exist');
  assert.ok(creation.artifactProjection, 'artifactProjection should be present');
  assert.equal(creation.artifactProjection.artifactId, 'art_123');
  assert.equal(creation.artifactProjection.previewTarget, '/api/v1/creations/images/img_abc');
  assert.equal(creation.artifactProjection.artifactType, 'IMAGE');
  assert.equal((creation.artifactProjection as any).providerId, undefined);
  assert.equal((creation.artifactProjection as any).modelId, undefined);
});

test('D. REAL_CLIENT_RENDER_TEST & IMAGE_THUMBNAIL_TEST', () => {
  const jsContent = fs.readFileSync(path.join(process.cwd(), 'public', 'personal-home-view.js'), 'utf-8');
  const mockWindow: any = { NAGEX_I18N: { getLocale: () => "en" }, NAGEX: { switchTab: () => {} } };

  // Evaluate the client code in a mocked environment
  const scriptFunc = new Function('window', `
    const document = { querySelectorAll: () => [], getElementById: () => null };
    ${jsContent}
    return window;
  `);

  const windowOut = scriptFunc(mockWindow);

  // Test Thumbnail
  const proj = toArtifactUxProjection(mockImageRecord);
  const thumbHtml = windowOut.NAGEX.renderArtifactThumbnail(proj);
  assert.ok(thumbHtml.includes('<img src="/api/v1/creations/images/img_abc"'));
  assert.ok(thumbHtml.includes('ph-artifact-thumbnail'));

  // Test missing preview safe fallback
  const noPreviewProj = { ...proj, previewTarget: null };
  const emptyThumb = windowOut.NAGEX.renderArtifactThumbnail(noPreviewProj);
  assert.equal(emptyThumb, '');
});

test('E. IMAGE_OPEN_DISPATCH_TEST & CANVAS UNAVAILABLE', () => {
  const jsContent = fs.readFileSync(path.join(process.cwd(), 'public', 'personal-home-view.js'), 'utf-8');
  const mockWindow: any = { NAGEX: { switchTab: () => {} } };

  const scriptFunc = new Function('window', `
    const document = { querySelectorAll: () => [], getElementById: () => null };
    ${jsContent}
    return window;
  `);

  const windowOut = scriptFunc(mockWindow);
  const proj = toArtifactUxProjection(mockImageRecord);

  const result = windowOut.NAGEX.dispatchArtifactOpen('IMAGE', mockImageRecord.artifactId, { artifactProjection: proj });

  assert.equal(result.status, 'CANVAS_NOT_AVAILABLE');
  assert.equal(result.artifactId, 'art_123');
  assert.equal(result.artifactType, 'IMAGE');

});

test('F. FUTURE/PLANNED TYPES do not dispatch', () => {
  const jsContent = fs.readFileSync(path.join(process.cwd(), 'public', 'personal-home-view.js'), 'utf-8');
  let alertCalled = false;
  const mockWindow: any = { alert: () => { alertCalled = true; }, NAGEX: { switchTab: () => {} } };

  const scriptFunc = new Function('window', `
    const document = { querySelectorAll: () => [], getElementById: () => null };
    ${jsContent}
    return window;
  `);
  const windowOut = scriptFunc(mockWindow);
  const proj = toArtifactUxProjection(mockPlannedRecord);

  const result = windowOut.NAGEX.dispatchArtifactOpen('VIDEO', mockPlannedRecord.artifactId, { artifactProjection: proj });

  assert.equal(result.status, 'PLANNED');
  assert.ok(alertCalled);
  assert.equal(windowOut.NAGEX._canvasState, undefined); // Never even tries to set canvas state
});

test('G. unknown artifact type safe fallback', () => {
  const unknownRecord = { ...mockImageRecord, type: 'UNKNOWN' as any };
  const proj = toArtifactUxProjection(unknownRecord);
  assert.equal(proj.previewKind, 'UNKNOWN');
  assert.equal(proj.previewTarget, null);
  assert.equal(proj.canvasTarget, '');
});
