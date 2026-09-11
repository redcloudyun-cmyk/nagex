// Phase 1 STEP 3 — Final Truthfulness Fix.
//
// BrowserRuntime.snapshot() previously capped extracted text at 4000
// characters with no way for a caller to tell a genuinely short page apart
// from a long one that was silently cut. This verifies the fix: snapshot()
// now reports the real pre-truncation length, and CaptureProcessor persists
// that truthfully instead of re-deriving a fake "total" from the
// already-capped text it received.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { URL } from 'node:url';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { QuickCaptureService } from '../src/workspace/quick-capture.service.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { AiService, type TextUnderstandingResult } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';

const sharedRuntime = new PlaywrightBrowserRuntime();
after(async () => {
  await sharedRuntime.shutdown();
});

const SHORT_TEXT = 'A brief note about the weekly newsletter schedule and next steps.';
// Longer than the 20,000-character snapshot bound so the real page is
// genuinely truncated by BrowserRuntime.snapshot() itself.
const SENTENCE = 'This is one sentence of a very long article about distributed systems and consensus protocols. ';
const HUGE_TEXT = SENTENCE.repeat(250); // ~24,500 characters

function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/short') {
      res.end(`<!doctype html><html><head><title>Short Page</title></head><body><p>${SHORT_TEXT}</p></body></html>`);
    } else if (url.pathname === '/huge') {
      res.end(`<!doctype html><html><head><title>Huge Page</title></head><body><p>${HUGE_TEXT}</p></body></html>`);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-snapshot-truncation-'));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function buildMockAiService(payload: Partial<TextUnderstandingResult> & { title: string; summary: string }): AiService {
  const full: TextUnderstandingResult = {
    contentType: 'article', topics: [], entities: [], dates: [], actionItems: [],
    taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [],
    ...payload,
  };
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-truncation-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

let ownerCounter = 0;
function buildHarness(aiService: AiService) {
  ownerCounter += 1;
  const ownerId = `usr_truncation_test_${ownerCounter}`;
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'browser-sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const browserService = new BrowserToolService(sharedRuntime, sessions, approvals, audit, memory);
  const service = new QuickCaptureService(store, undefined, undefined, undefined, undefined, aiService, browserService);
  return { service, sessions, browserService, ownerId, tenantId: 'ten_truncation_step3' };
}

test('1. A page under the snapshot limit reports truncated=false and totalCharacters == returnedCharacters', async () => {
  const fixture = await startFixtureServer();
  try {
    const { browserService, ownerId, tenantId } = buildHarness(buildMockAiService({ title: 'x', summary: 'x' }));
    const input = { tenantId, ownerId, requestId: 'req_snap_short' };
    const session = await browserService.open(input);
    const sInput = { ...input, browserSessionId: session.browserSessionId };
    await browserService.navigate({ ...sInput, url: fixture.origin + '/short' });
    const snap = await browserService.snapshot(sInput);

    assert.equal(snap.truncated, false);
    assert.equal(snap.totalCharacters, snap.returnedCharacters);
    assert.equal(snap.text.length, snap.returnedCharacters);
    assert.equal(snap.text.trim(), SHORT_TEXT);

    await browserService.close(sInput);
  } finally {
    await fixture.close();
  }
});

test('2. A page over the snapshot limit reports truncated=true and the real pre-truncation totalCharacters', async () => {
  const fixture = await startFixtureServer();
  try {
    const { browserService, ownerId, tenantId } = buildHarness(buildMockAiService({ title: 'x', summary: 'x' }));
    const input = { tenantId, ownerId, requestId: 'req_snap_huge' };
    const session = await browserService.open(input);
    const sInput = { ...input, browserSessionId: session.browserSessionId };
    await browserService.navigate({ ...sInput, url: fixture.origin + '/huge' });
    const snap = await browserService.snapshot(sInput);

    assert.equal(snap.truncated, true);
    assert.ok(snap.totalCharacters > snap.returnedCharacters);
    // The real page really was this long — never a guessed/rounded number.
    assert.equal(snap.totalCharacters, HUGE_TEXT.trim().length);
    assert.equal(snap.text.length, snap.returnedCharacters);

    await browserService.close(sInput);
  } finally {
    await fixture.close();
  }
});

test('3. CaptureProcessor.processUrl() persists the same truthful truncation metadata for a short page', async () => {
  const fixture = await startFixtureServer();
  try {
    const { service, ownerId, tenantId } = buildHarness(buildMockAiService({ title: 'Short Page', summary: 'A brief note.' }));
    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/short', source: 'WEB' });

    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.truncated, false);
    assert.equal(item.metadata.totalCharacters, item.metadata.processedCharacters);
    assert.equal(item.metadata.totalCharacters, SHORT_TEXT.length);
  } finally {
    await fixture.close();
  }
});

test('4. A truncated page never reports fabricated full-page metadata', async () => {
  const fixture = await startFixtureServer();
  try {
    const { service, ownerId, tenantId } = buildHarness(buildMockAiService({ title: 'Huge Page', summary: 'A long article about distributed systems.' }));
    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/huge', source: 'WEB' });

    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.truncated, true);
    // totalCharacters must be the REAL full page length, not merely the
    // capped snapshot's length re-reported as if it were the total.
    assert.equal(item.metadata.totalCharacters, HUGE_TEXT.trim().length);
    assert.ok((item.metadata.totalCharacters || 0) > (item.metadata.processedCharacters || 0));
    // characterCount (the general-purpose field other capture types also
    // use) must agree with totalCharacters — never a smaller, quietly
    // "full-looking" number.
    assert.equal(item.metadata.characterCount, item.metadata.totalCharacters);
  } finally {
    await fixture.close();
  }
});

test('5. The browser session still closes after a large, truncated retrieval', async () => {
  const fixture = await startFixtureServer();
  try {
    const { service, sessions, ownerId, tenantId } = buildHarness(buildMockAiService({ title: 'Huge Page', summary: 'A long article.' }));
    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/huge', source: 'WEB' });

    assert.ok(item.metadata.browserSessionId);
    assert.equal(sessions.get(item.metadata.browserSessionId!)?.status, 'CLOSED');
  } finally {
    await fixture.close();
  }
});
