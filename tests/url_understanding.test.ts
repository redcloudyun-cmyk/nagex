// Phase 1 STEP 3 — Real URL Understanding.
//
// Exercises CaptureProcessor's LINK path against a REAL Playwright browser
// (the same PlaywrightBrowserRuntime used by browser_agent.test.ts) reading
// a real local HTTP fixture, combined with a real AiService/UnifiedModelRouter
// whose HTTP layer is mocked (same pattern as text_understanding.test.ts) —
// never a fake fetch()/scraper bypass and never a fabricated understanding.
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
import { BrowserSessionStore } from '../src/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime } from '../src/integrations/browser/browser.runtime.js';
import { BrowserToolService } from '../src/tools/browser.service.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { AiService, type TextUnderstandingResult } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';

// One real Chromium process for this whole file (never one per test — see
// the Phase B process-leak lesson in browser_agent.test.ts).
const sharedRuntime = new PlaywrightBrowserRuntime();
after(async () => {
  await sharedRuntime.shutdown();
});

let changingCounter = 0;

function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/') {
      res.end(`<!doctype html><html><head><title>Weekend Hiking Trails</title></head><body><h1>Weekend Hiking Trails</h1><p>A roundup of scenic hiking trails for a weekend trip, with photos and trail difficulty ratings.</p></body></html>`);
    } else if (url.pathname === '/meeting') {
      res.end(`<!doctype html><html><head><title>Team Sync Notes</title></head><body><h1>Team Sync Notes</h1><p>The team agreed to meet again on 2026-09-22 at 10:00 AM to review the launch checklist. Someone needs to send the updated deck beforehand.</p></body></html>`);
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end();
    } else if (url.pathname === '/redirect-target') {
      res.end(`<!doctype html><html><head><title>Redirect Target</title></head><body><h1>You arrived via redirect</h1><p>This is the real final destination page.</p></body></html>`);
    } else if (url.pathname === '/captcha') {
      res.end(`<!doctype html><html><head><title>Verify</title></head><body><p>Please verify you are human before continuing.</p></body></html>`);
    } else if (url.pathname === '/empty') {
      res.end(`<!doctype html><html><head><title></title></head><body></body></html>`);
    } else if (url.pathname === '/changing') {
      changingCounter += 1;
      res.end(`<!doctype html><html><head><title>Changing Page</title></head><body><p>Revision ${changingCounter}: ${changingCounter === 1 ? 'Nothing urgent today.' : 'New deadline: submit the report by Friday.'}</p></body></html>`);
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-url-understanding-'));
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
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-url-model' },
    async () => jsonResponse({ output_text: JSON.stringify(full) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

// Throws if the model is ever actually invoked — used to prove a failed or
// empty retrieval never reaches "understanding" at all.
function buildPoisonAiService(): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-url-model' },
    async () => { throw new Error('AiService must never be called for this retrieval outcome'); },
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

let ownerCounter = 0;
function buildHarness(aiService: AiService, isRuntimeAvailable?: () => boolean) {
  ownerCounter += 1;
  const ownerId = `usr_url_test_${ownerCounter}`;
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const sessions = new BrowserSessionStore({ dir: path.join(dir, 'browser-sessions') });
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();
  const browserService = isRuntimeAvailable
    ? new BrowserToolService(sharedRuntime, sessions, approvals, audit, memory, undefined, undefined, isRuntimeAvailable)
    : new BrowserToolService(sharedRuntime, sessions, approvals, audit, memory);
  const service = new QuickCaptureService(store, undefined, undefined, undefined, undefined, aiService, browserService);
  return { store, sessions, service, ownerId, tenantId: 'ten_url_step3' };
}

test('1. Normal public webpage: real browser retrieval, real extracted text, real structured understanding', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildMockAiService({ title: 'Weekend Hiking Trails', summary: 'A roundup of scenic weekend hiking trails.' });
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/', source: 'WEB' });

    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.pageTitle, 'Weekend Hiking Trails');
    assert.equal(item.metadata.extractedSummary, 'A roundup of scenic weekend hiking trails.');
    assert.equal(item.metadata.sourceUrl, fixture.origin + '/');
    assert.ok(item.metadata.contentHash);
    assert.ok((item.metadata.characterCount || 0) > 0);
    assert.match(item.metadata.browserSessionId || '', /^brw_/);
  } finally {
    await fixture.close();
  }
});

test('2. Redirect: finalUrl is recorded truthfully, distinct from the originally-requested URL', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildMockAiService({ title: 'Redirect Target', summary: 'Landed on the real final destination page.' });
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/redirect', source: 'WEB' });

    assert.equal(item.metadata.sourceUrl, fixture.origin + '/redirect');
    assert.equal(item.metadata.finalUrl, fixture.origin + '/redirect-target');
    assert.equal(item.metadata.pageTitle, 'Redirect Target');
  } finally {
    await fixture.close();
  }
});

test('3. Unsafe URL (disallowed scheme) is blocked before any navigation is attempted', async () => {
  // Private-IP/cloud-metadata blocking (169.254.169.254 etc.) is exercised
  // directly against isUrlSafe() in browser_agent_mvp.test.ts — this suite
  // globally sets NAGEX_ALLOW_LOCAL_TEST_URLS=1 so other tests can reach
  // their local fixture servers, which also relaxes that specific check.
  // A disallowed scheme is blocked unconditionally regardless of that flag,
  // so it still proves processUrl() genuinely rejects before ever opening a
  // browser session.
  const aiService = buildPoisonAiService();
  const { service, ownerId, tenantId } = buildHarness(aiService);

  const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: 'file:///etc/passwd', source: 'WEB' });

  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'BROWSER_UNSAFE_URL');
  assert.equal(item.metadata.browserSessionId, undefined);
});

test('4. Browser unavailable produces a real FAILED / BROWSER_UNAVAILABLE, never a fabricated page', async () => {
  const aiService = buildPoisonAiService();
  const { service, ownerId, tenantId } = buildHarness(aiService, () => false);

  const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: 'https://example.com/article', source: 'WEB' });

  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'BROWSER_UNAVAILABLE');
  assert.doesNotMatch(item.metadata.extractedSummary || '', /example\.com/i);
});

test('5. CAPTCHA/human verification page: NEEDS_REVIEW/BLOCKED_NEEDS_HUMAN, no understanding attempted, session closed', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildPoisonAiService(); // proves understand() is never reached
    const { service, sessions, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/captcha', source: 'WEB' });

    assert.equal(item.status, 'NEEDS_REVIEW');
    assert.equal(item.metadata.errorCode, 'BLOCKED_NEEDS_HUMAN');
    assert.ok(item.metadata.browserSessionId);
    assert.equal(sessions.get(item.metadata.browserSessionId!)?.status, 'CLOSED');
  } finally {
    await fixture.close();
  }
});

test('6. Empty/no-useful-content page: truthful NEEDS_REVIEW/EMPTY_PAGE, no fabricated summary, no understanding attempted', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildPoisonAiService();
    const { service, sessions, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/empty', source: 'WEB' });

    assert.equal(item.status, 'NEEDS_REVIEW');
    assert.equal(item.metadata.errorCode, 'EMPTY_PAGE');
    assert.equal(item.metadata.extractedSummary, `Retrieved page (${fixture.origin}/empty) contained no readable text.`);
    assert.equal(sessions.get(item.metadata.browserSessionId!)?.status, 'CLOSED');
  } finally {
    await fixture.close();
  }
});

test('7. Explicit date/action in the page grounds a real candidate', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildMockAiService({
      title: 'Team Sync Notes', summary: 'Team sync scheduled to review the launch checklist.',
      dates: [{ text: '2026-09-22', normalized: '2026-09-22', confidence: 0.9 }],
      actionItems: [{ text: 'Send the updated deck', confidence: 0.8 }],
      calendarCandidates: [{ title: 'Team Sync', startCandidate: '2026-09-22T10:00:00', confidence: 0.85 }],
    });
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/meeting', source: 'WEB' });

    assert.equal(item.status, 'NEEDS_REVIEW');
    const candidates = item.metadata.candidates || [];
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].type, 'CALENDAR');
    assert.equal(candidates[0].status, 'PROPOSED');
    assert.equal((item.metadata.dates || [])[0].normalized, '2026-09-22');
  } finally {
    await fixture.close();
  }
});

test('8. Unrelated article: no fake candidate is invented', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildMockAiService({ title: 'Weekend Hiking Trails', summary: 'A roundup of scenic weekend hiking trails.' });
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/', source: 'WEB' });

    assert.equal(item.status, 'READY');
    assert.equal((item.metadata.candidates || []).length, 0);
  } finally {
    await fixture.close();
  }
});

test('9. Invalid JSON from one provider triggers real fallback, never a fake result from the garbage response', async () => {
  const fixture = await startFixtureServer();
  try {
    const validPayload: TextUnderstandingResult = {
      title: 'Weekend Hiking Trails', summary: 'Understood via the fallback provider.', contentType: 'article',
      topics: [], entities: [], dates: [], actionItems: [], taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [],
    };
    const fetchFn: typeof fetch = async (url) => String(url).includes('openai.com')
      ? jsonResponse({ output_text: 'not json at all' })
      : jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(validPayload) }] } }] });
    const providers = createProviders({ OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa', GEMINI_API_KEY: 'g', NAGEX_GEMINI_MODEL: 'gm' }, fetchFn);
    const aiService = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/', source: 'WEB' });

    assert.equal(item.status, 'READY');
    assert.equal(item.metadata.extractedSummary, 'Understood via the fallback provider.');
    assert.equal(item.metadata.modelProvider, 'gemini');
  } finally {
    await fixture.close();
  }
});

test('10. Retry on unchanged content does not duplicate a candidate the user already decided on', async () => {
  const fixture = await startFixtureServer();
  try {
    const aiService = buildMockAiService({
      title: 'Team Sync Notes', summary: 'Team sync scheduled.',
      calendarCandidates: [{ title: 'Team Sync', startCandidate: '2026-09-22T10:00:00', confidence: 0.85 }],
    });
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const item = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/meeting', source: 'WEB' });
    const candidateId = (item.metadata.candidates || [])[0].candidateId;
    await service.actionCandidate({ captureId: item.captureId, candidateId, action: 'ACCEPT', ownerId, tenantId });

    const retried = await service.retryCapture(item.captureId, ownerId);
    const finalCandidates = retried?.metadata.candidates || [];
    assert.equal(finalCandidates.length, 1);
    assert.equal(finalCandidates[0].status, 'ACCEPTED');
  } finally {
    await fixture.close();
  }
});

test('11. Changed page content (changed contentHash) permits new understanding rather than reusing stale results', async () => {
  const fixture = await startFixtureServer();
  try {
    changingCounter = 0;
    let callCount = 0;
    const providers = createProviders(
      { OPENAI_API_KEY: 'a', NAGEX_OPENAI_MODEL: 'oa' },
      async () => {
        callCount += 1;
        const payload: TextUnderstandingResult = callCount === 1
          ? { title: 'Changing Page', summary: 'Nothing urgent today.', contentType: 'note', topics: [], entities: [], dates: [], actionItems: [], taskCandidates: [], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [] }
          : { title: 'Changing Page', summary: 'New deadline: submit the report by Friday.', contentType: 'note', topics: [], entities: [], dates: [], actionItems: [], taskCandidates: [{ title: 'Submit the report', confidence: 0.9 }], calendarCandidates: [], memoryCandidates: [], knowledgeCandidates: [] };
        return jsonResponse({ output_text: JSON.stringify(payload) });
      },
    );
    const aiService = new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
    const { service, ownerId, tenantId } = buildHarness(aiService);

    const first = await service.captureTextOrLink({ ownerId, tenantId, type: 'LINK', content: fixture.origin + '/changing', source: 'WEB' });
    assert.equal(first.status, 'READY');
    const firstHash = first.metadata.contentHash;

    const retried = await service.retryCapture(first.captureId, ownerId);
    assert.notEqual(retried?.metadata.contentHash, firstHash);
    assert.equal(retried?.status, 'NEEDS_REVIEW');
    assert.equal((retried?.metadata.candidates || []).length, 1);
    assert.equal((retried?.metadata.candidates || [])[0].title, 'Submit the report');
  } finally {
    await fixture.close();
  }
});

test('12. The browser session is always closed after retrieval — success, EMPTY_PAGE, and CAPTCHA paths alike', async () => {
  const fixture = await startFixtureServer();
  try {
    const successAi = buildMockAiService({ title: 'Weekend Hiking Trails', summary: 'A roundup.' });
    const { service: s1, sessions: sess1, ownerId: o1, tenantId } = buildHarness(successAi);
    const successItem = await s1.captureTextOrLink({ ownerId: o1, tenantId, type: 'LINK', content: fixture.origin + '/', source: 'WEB' });
    assert.equal(sess1.get(successItem.metadata.browserSessionId!)?.status, 'CLOSED');

    const emptyAi = buildPoisonAiService();
    const { service: s2, sessions: sess2, ownerId: o2 } = buildHarness(emptyAi);
    const emptyItem = await s2.captureTextOrLink({ ownerId: o2, tenantId, type: 'LINK', content: fixture.origin + '/empty', source: 'WEB' });
    assert.equal(sess2.get(emptyItem.metadata.browserSessionId!)?.status, 'CLOSED');

    const captchaAi = buildPoisonAiService();
    const { service: s3, sessions: sess3, ownerId: o3 } = buildHarness(captchaAi);
    const captchaItem = await s3.captureTextOrLink({ ownerId: o3, tenantId, type: 'LINK', content: fixture.origin + '/captcha', source: 'WEB' });
    assert.equal(sess3.get(captchaItem.metadata.browserSessionId!)?.status, 'CLOSED');
  } finally {
    await fixture.close();
  }
});

test('13. There is no direct fetch()/scraper bypass path for URL retrieval', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'workspace', 'capture-processor.ts'), 'utf8');
  const start = src.indexOf('private async processUrl(');
  const end = src.indexOf('\n  private async processPdf(', start);
  // Strip comments first so a comment merely mentioning "fetch()" in prose
  // (e.g. explaining why there isn't one) can't produce a false positive.
  const body = src.slice(start, end).replace(/\/\/.*$/gm, '');

  // The only network retrieval in this method goes through this.browserService.
  assert.doesNotMatch(body, /\bfetch\(/);
  assert.doesNotMatch(body, /http\.request|https\.request|XMLHttpRequest/);
  assert.match(body, /this\.browserService\.open/);
  assert.match(body, /this\.browserService\.navigate/);

  // Behavioral proof: without a browserService, LINK capture fails closed —
  // it never falls back to fabricating page content (the bug this replaced).
  const aiService = buildPoisonAiService();
  const dir = tempDir();
  const store = new CaptureStore(path.join(dir, 'captures'));
  const service = new QuickCaptureService(store, undefined, undefined, undefined, undefined, aiService);
  const item = await service.captureTextOrLink({ ownerId: 'usr_no_browser', tenantId: 'ten_url_step3', type: 'LINK', content: 'https://example.com/article', source: 'WEB' });
  assert.equal(item.status, 'FAILED');
  assert.equal(item.metadata.errorCode, 'BROWSER_UNAVAILABLE');
});

test('14. Existing Browser Agent open/navigate/snapshot/close lifecycle remains green alongside URL understanding', async () => {
  const fixture = await startFixtureServer();
  try {
    const sessions = new BrowserSessionStore({ dir: path.join(tempDir(), 'browser-sessions') });
    const browserService = new BrowserToolService(sharedRuntime, sessions, new ActionApprovalStore(), new AuditLogger(), new MemoryEngine());
    const input = { tenantId: 'ten_url_step3', ownerId: 'usr_step3_regression', requestId: 'req_regr' };

    const session = await browserService.open(input);
    const sInput = { ...input, browserSessionId: session.browserSessionId };
    const nav = await browserService.navigate({ ...sInput, url: fixture.origin + '/' });
    assert.equal(nav.title, 'Weekend Hiking Trails');
    const snap = await browserService.snapshot(sInput);
    assert.match(snap.text, /scenic hiking trails/);
    await browserService.close(sInput);
    assert.equal(sessions.get(session.browserSessionId)?.status, 'CLOSED');
  } finally {
    await fixture.close();
  }
});

// NOTE: a dedicated "large page triggers chunk+synthesis" test is not
// included here. BrowserRuntime.snapshot() (browser.runtime.ts,
// MAX_SNAPSHOT_TEXT_LENGTH) already caps extracted page text at 4000
// characters, below this file's 8000-character chunking threshold — so a
// real Browser Agent retrieval can never actually reach the chunk/synthesis
// branch today. The branch is implemented and reachable (analyzeLargeDocument
// is the same code PDF understanding already exercises), but genuinely
// testing it end-to-end through URL retrieval would require either lowering
// the chunking threshold to fit the test (not honest) or first raising the
// snapshot layer's own cap (out of scope for STEP 3 — see the STEP 3 report's
// gaps).
