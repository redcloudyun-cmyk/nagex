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

  // R24.7B — minimal DOM element surface. Canvas Ask / the read-only document
  // view build and mark up nodes (createElement/appendChild/setAttribute), so
  // the mock element must support that much; it is still a plain object, never
  // a second implementation of any production logic.
  const mockElement = (id: string): any => {
    const el: any = {
      id, textContent: '', style: {}, href: '', hidden: false, value: '', disabled: false, isConnected: true,
      attrs: {} as Record<string, string>, children: [] as any[], _html: '',
      // Like a real element, assigning innerHTML replaces (here: empties) the children.
      get innerHTML() { return el._html; },
      set innerHTML(v: string) { el._html = v; el.children = []; },
      setAttribute(k: string, v: string) { el.attrs[k] = String(v); },
      removeAttribute(k: string) { delete el.attrs[k]; },
      getAttribute(k: string) { return k in el.attrs ? el.attrs[k] : null; },
      appendChild(child: any) { el.children.push(child); return child; },
    };
    return el;
  };

  const mockDocument = {
    getElementById: (id: string) => {
      if (!elements[id]) {
        elements[id] = mockElement(id);
      }
      return elements[id];
    },
    createElement: (tag: string) => mockElement(tag),
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
  // R23.7H-C Phase D.1 §7 — the toolbar shows the real artifact title, not
  // a raw artifact ID (removed as a technical-UI leak); artifactId remains
  // the canonical identity used everywhere else (state.artifactId above).
  assert.equal(elements['canvas-artifact-title'].textContent, proj.title);
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

// R24.7B (supersedes the R23.7H-C Phase C contract that asserted the DOCUMENT
// renderer shows the "DOCUMENT Workspace / Metadata preview" placeholder):
// the DOCUMENT renderer now shows the REAL, canonical document body, read-only.
// Stricter, not weaker: it must load the body from the artifact's own
// same-origin NAgex API target, show a truthful loading state, display the
// text only through textContent (document Markdown/HTML never executes), offer
// no editor/mutation control, and show a truthful error when the body cannot
// be loaded — never the old placeholder.
test('M. DOCUMENT renderer truthful (R24.7B: real read-only content)', async () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  const requested: string[] = [];
  const evil = '# Heading <img src=x onerror=alert(1)> <script>alert(2)</script>';
  mockWindow.NAGEX.apiFetch = async (url: string) => { requested.push(url); return { document: { content: evil } }; };
  const proj = toArtifactUxProjection(mockDocRecord);

  mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  const region = elements['canvas-renderer-region'];
  assert.equal(region.children[0].textContent, 'Loading document…', 'truthful loading state first');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requested, [mockDocRecord.openTarget], 'the body is read from the artifact\'s own same-origin API target');
  const wrap = region.children[0];
  const pre = wrap.children.find((c: any) => c.className === 'canvas-document-text');
  assert.equal(pre.textContent, evil, 'content is assigned as text, verbatim');
  assert.equal(region.innerHTML, '', 'no HTML string is ever injected for document content');
  assert.equal(JSON.stringify(region).includes('DOCUMENT Workspace'), false);
  assert.equal(JSON.stringify(region).includes('Metadata preview'), false);
  assert.equal(JSON.stringify(region).includes('textarea'), false, 'read-only: no editor');
  assert.equal(mockWindow.NAGEX._canvasState.loadStatus, 'READY');
});

test('M2. DOCUMENT renderer shows a truthful error — never fake content — when the body cannot be loaded', async () => {
  const { mockWindow, elements } = setupMockDOM();
  elements['view-canvas'] = true;
  mockWindow.NAGEX.apiFetch = async () => ({ error: 'DOCUMENT_NOT_FOUND' });
  const proj = toArtifactUxProjection(mockDocRecord);
  mockWindow.NAGEX.openArtifactInCanvas(proj.artifactId, proj.artifactType, proj.canvasTarget, proj.openTarget, proj);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements['canvas-renderer-region'].children[0].textContent, 'This document could not be loaded.');
  assert.equal(mockWindow.NAGEX._canvasState.loadStatus, 'ERROR');
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
