import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toArtifactUxProjection, type ArtifactRecord } from '../src/artifacts/artifact.types.js';

const mockImageRecord: ArtifactRecord = {
  artifactId: 'art_c123',
  tenantId: 'ten_test',
  ownerId: 'usr_test',
  type: 'IMAGE',
  status: 'COMPLETED',
  title: 'Canvas Test Image',
  preview: 'Image in canvas',
  sourceType: 'CAPTURE',
  sourceId: 'cap_1',
  openTarget: '/api/v1/creations/images/img_abc',
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
};

const mockDocRecord: ArtifactRecord = {
  ...mockImageRecord,
  artifactId: 'art_doc',
  type: 'DOCUMENT',
  openTarget: '/api/v1/artifacts/art_doc',
};

const mockPlannedRecord: ArtifactRecord = {
  ...mockImageRecord,
  artifactId: 'art_video',
  type: 'VIDEO',
  openTarget: '',
};

function setupMockDOM() {
  const htmlContent = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf-8');
  const jsContent = fs.readFileSync(path.join(process.cwd(), 'public', 'personal-home-view.js'), 'utf-8');

  // We parse the minimal DOM required for canvas test.
  // Using a mock document object.
  const elements: Record<string, any> = {};
  
  const mockDocument = {
    getElementById: (id: string) => {
      if (!elements[id]) {
        elements[id] = { id, textContent: '', innerHTML: '', style: {}, href: '' };
      }
      return elements[id];
    },
    querySelectorAll: () => []
  };
  
  // Actually, we can use JSDOM if available, or just mock the basic methods.
  // Since we only manipulate simple elements in openArtifactInCanvas:
  let switchedTab = '';
  const mockWindow: any = { 
    NAGEX_I18N: { getLocale: () => 'en' },
    NAGEX: {
      switchTab: (tab: string) => { switchedTab = tab; }
    },
    alert: (msg: string) => { elements['alert'] = msg; }
  };
  
  const scriptFunc = new Function('window', 'document', `
    ${jsContent}
    return window;
  `);
  
  scriptFunc(mockWindow, mockDocument);
  
  return { mockWindow, mockDocument, elements, getSwitchedTab: () => switchedTab };
}

test('A. IMAGE artifact opens real Canvas', () => {
  const { mockWindow, elements, getSwitchedTab } = setupMockDOM();
  const proj = toArtifactUxProjection(mockImageRecord);
  
  // Ensure view-canvas exists in mock DOM
  elements['view-canvas'] = true;
  
  const res = mockWindow.NAGEX.dispatchArtifactOpen('IMAGE', proj.artifactId, { artifactProjection: proj });
  assert.equal(res.status, 'LOADING');
  assert.equal(getSwitchedTab(), 'tab-canvas');
});

test('B. OPENED only after real Canvas render', () => {
  const { mockWindow, elements } = setupMockDOM();
  const proj = toArtifactUxProjection(mockImageRecord);
  
  // If view-canvas is MISSING from DOM, it should return CANVAS_NOT_AVAILABLE
  delete elements['view-canvas'];
  const mockDocument = {
      getElementById: (id: string) => id === 'view-canvas' ? null : elements[id],
      querySelectorAll: () => []
  };
  
  const jsContent = fs.readFileSync(path.join(process.cwd(), 'public', 'personal-home-view.js'), 'utf-8');
  const scriptFunc = new Function('window', 'document', `
    ${jsContent}
    return window;
  `);
  const mw: any = { NAGEX: { switchTab: () => {} } };
  scriptFunc(mw, mockDocument);
  
  const res = mw.NAGEX.dispatchArtifactOpen('IMAGE', proj.artifactId, { artifactProjection: proj });
  assert.equal(res.status, 'CANVAS_NOT_AVAILABLE');
});

test('C. canonical artifactId preserved & E. no client imageId derivation', () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection(mockImageRecord);
  
  const state = mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  assert.equal(state.artifactId, 'art_c123');
  assert.equal(elements['canvas-artifact-title'].textContent, 'Artifact: art_c123');
});

test('D. canonical IMAGE target used & F. no provider URL', () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection(mockImageRecord);
  
  mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  
  assert.equal(elements['canvas-img-element'].src, '/api/v1/creations/images/img_abc');
  const html = elements['canvas-renderer-region'].innerHTML;
  assert.equal(html.includes('openai'), false); // No provider URL
});

test('J. UNKNOWN -> safe unsupported', () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection({ ...mockImageRecord, type: 'UNKNOWN' as any });
  
  const res = mockWindow.NAGEX.dispatchArtifactOpen('UNKNOWN', proj.artifactId, { artifactProjection: proj });
  assert.equal(res.status, 'UNKNOWN');
});

test('K. PRESENTATION planned -> no fake success', () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection(mockPlannedRecord);
  
  const res = mockWindow.NAGEX.dispatchArtifactOpen('VIDEO', proj.artifactId, { artifactProjection: proj });
  assert.equal(res.status, 'PLANNED');
  assert.ok(elements['alert']);
});

test('M. DOCUMENT renderer truthful', () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection(mockDocRecord);
  
  mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  const html = elements['canvas-renderer-region'].innerHTML;
  assert.ok(html.includes('DOCUMENT Workspace'));
  assert.ok(html.includes('Metadata preview'));
});

test('P. Canvas close/back', () => {
  const { mockWindow, getSwitchedTab, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const proj = toArtifactUxProjection(mockImageRecord);
  mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  
  mockWindow.NAGEX.closeCanvas();
  assert.equal(getSwitchedTab(), 'tab-home');
  assert.equal(mockWindow.NAGEX._canvasState.active, false);
});
