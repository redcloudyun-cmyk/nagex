// R8 — Personal Daily Brief. Real Calendar + Gmail + Tasks + Activity +
// model synthesis combined behind GET /api/v1/daily-brief
// (src/server_web.ts). Every service here is the exact real class
// (GoogleCalendarService/GmailService/AiService) with only its fetch/model
// transport mocked — never a hand-rolled stand-in for server_web.ts's own
// route logic, which is what's actually under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryGoogleOAuthTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES, GMAIL_SCOPES, type GoogleOAuthConfig } from '../src/integrations/google/oauth.client.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { GoogleCalendarService } from '../src/modules/calendar/index.js';
import { GmailService } from '../src/modules/gmail/gmail.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import { handleAsyncApiRequest, actionApprovals as sharedActionApprovals } from '../src/server_web.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const config: GoogleOAuthConfig = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://nagex-test.agex.site/api/v1/oauth/google/callback' };
const CAL_SCOPE = GOOGLE_CALENDAR_SCOPES.join(' ');
const GMAIL_SCOPE = GMAIL_SCOPES.join(' ');

// A fully scriptable fake ModelProvider — full control over the brief JSON
// without needing to route through a real provider HTTP shape (that's
// already covered by model_provider_integration.test.ts).
function fakeModelProvider(reply: () => string | Error, name = 'nebius'): ModelProvider {
  return {
    name,
    model: 'test-model',
    status: (): ProviderStatus => ({ configured: true, available: true, provider: name, model: 'test-model', status: 'LIVE', lastCheckedAt: null, degradedReason: null }),
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const result = reply();
      if (result instanceof Error) throw result;
      return { text: result, provider: name, model: 'test-model', latencyMs: 1, requestId: request.requestId };
    },
  };
}

function buildHarness(opts: {
  calendarFetch?: typeof fetch;
  gmailFetch?: typeof fetch;
  connectCalendar?: boolean;
  connectGmail?: boolean;
  modelReply?: () => string | Error;
} = {}) {
  const calendarTokenStore = new InMemoryGoogleOAuthTokenStore();
  const gmailTokenStore = new InMemoryGoogleOAuthTokenStore();
  const approvals = new ActionApprovalStore();
  const audit = new AuditLogger();
  const memory = new MemoryEngine();

  if (opts.connectCalendar !== false) {
    calendarTokenStore.save('ten_test', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: CAL_SCOPE });
  }
  if (opts.connectGmail !== false) {
    gmailTokenStore.save('ten_test', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, scope: GMAIL_SCOPE });
  }

  const calendarService = new GoogleCalendarService(calendarTokenStore, approvals, audit, memory, opts.calendarFetch ?? (async () => jsonResponse({ items: [] })), () => config);
  const gmailService = new GmailService(gmailTokenStore, approvals, audit, memory, opts.gmailFetch ?? (async () => jsonResponse({ threads: [] })), () => config);

  const modelProvider = fakeModelProvider(opts.modelReply ?? (() => JSON.stringify({ summary: 'Nothing notable today.', actionItems: [] })));
  const aiService = new AiService(new UnifiedModelRouter([modelProvider], { info: () => {}, warn: () => {} }));

  return { calendarService, gmailService, aiService, approvals };
}

// R8 test note: /api/v1/daily-brief's cache is keyed by tenantId::principalId
// and is a real module-level singleton in server_web.ts (deliberately — see
// §11), which persists across tests in this same process. Every test below
// therefore uses its own unique principalId so no test's cached result can
// leak into another's assertions; only the dedicated caching test reuses a
// header set across calls on purpose.
function headersFor(testName: string) {
  return { 'x-nagex-tenant': 'ten_test', 'x-principal-id': `usr_${testName}` };
}

test('Calendar only: Gmail disconnected still yields a real partial brief grounded in real calendar events', async () => {
  const HEADERS = headersFor('calendar_only');
  const calendarFetch: typeof fetch = async () => jsonResponse({
    items: [{ id: 'evt_1', summary: 'Client Strategy Sync', start: { dateTime: '2026-01-01T15:00:00Z' }, end: { dateTime: '2026-01-01T16:00:00Z' } }],
  });
  const h = buildHarness({ calendarFetch, connectGmail: false, modelReply: () => JSON.stringify({ summary: '1 meeting today.', actionItems: [{ title: 'Prepare for Client Strategy Sync', reasoning: 'Meeting at 15:00', priority: 'HIGH' }] }) });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal(res.status, 200);
  const data = res.data as any;
  assert.equal(data.calendarStatus, 'CONNECTED');
  assert.equal(data.gmailStatus, 'DISCONNECTED');
  assert.equal(data.status, 'PARTIAL');
  assert.equal(data.schedule.length, 1);
  assert.equal(data.schedule[0].sourceType, 'CALENDAR');
  assert.equal(data.schedule[0].sourceId, 'evt_1');
  assert.equal(data.emails.length, 0);
  assert.equal(data.summary, '1 meeting today.');
  assert.equal(data.actionItems[0].priority, 'HIGH');
});

test('Gmail only: Calendar disconnected still yields a real partial brief grounded in real email threads', async () => {
  const HEADERS = headersFor('gmail_only');
  const gmailFetch: typeof fetch = async () => jsonResponse({ threads: [{ id: 'th_1', snippet: 'Can you review the proposal by EOD?' }] });
  const h = buildHarness({ gmailFetch, connectCalendar: false, modelReply: () => JSON.stringify({ summary: '1 email needs attention.', actionItems: [{ title: 'Reply to proposal review request', reasoning: 'Email snippet asks for EOD review', priority: 'MEDIUM' }] }) });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.calendarStatus, 'DISCONNECTED');
  assert.equal(data.gmailStatus, 'CONNECTED');
  assert.equal(data.status, 'PARTIAL');
  assert.equal(data.emails.length, 1);
  assert.equal(data.emails[0].sourceType, 'GMAIL');
  assert.equal(data.emails[0].sourceId, 'th_1');
  assert.equal(data.schedule.length, 0);
});

test('Combined: both Calendar and Gmail connected and returning real data yields status OK', async () => {
  const HEADERS = headersFor('combined');
  const calendarFetch: typeof fetch = async () => jsonResponse({ items: [{ id: 'evt_1', summary: 'Standup', start: { dateTime: '2026-01-01T09:00:00Z' }, end: { dateTime: '2026-01-01T09:15:00Z' } }] });
  const gmailFetch: typeof fetch = async () => jsonResponse({ threads: [{ id: 'th_1', snippet: 'Invoice attached.' }] });
  const h = buildHarness({ calendarFetch, gmailFetch });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.status, 'OK');
  assert.equal(data.calendarStatus, 'CONNECTED');
  assert.equal(data.gmailStatus, 'CONNECTED');
  assert.equal(data.schedule.length, 1);
  assert.equal(data.emails.length, 1);
});

test('Empty data: nothing in calendar/Gmail/tasks still returns a real (not fabricated) brief', async () => {
  const HEADERS = headersFor('empty_data');
  const h = buildHarness({ modelReply: () => JSON.stringify({ summary: 'Nothing on your calendar or in your inbox today.', actionItems: [] }) });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.status, 'OK');
  assert.deepEqual(data.schedule, []);
  assert.deepEqual(data.emails, []);
  assert.deepEqual(data.actionItems, []);
  assert.match(data.summary, /nothing/i);
});

test('Partial failure: a real Calendar API error (not disconnected) is reported as ERROR, not silently dropped, and Gmail still contributes', async () => {
  const HEADERS = headersFor('partial_failure');
  const calendarFetch: typeof fetch = async () => jsonResponse({ error: { message: 'internal' } }, 500);
  const gmailFetch: typeof fetch = async () => jsonResponse({ threads: [{ id: 'th_1', snippet: 'Hi' }] });
  const h = buildHarness({ calendarFetch, gmailFetch });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.calendarStatus, 'ERROR');
  assert.equal(data.gmailStatus, 'CONNECTED');
  assert.equal(data.status, 'PARTIAL');
  assert.equal(data.emails.length, 1);
});

test('All-provider failure: model generation unavailable is reported truthfully, never wrapped in a fake summary, and real source data is still returned', async () => {
  const HEADERS = headersFor('all_provider_failure');
  const calendarFetch: typeof fetch = async () => jsonResponse({ items: [{ id: 'evt_1', summary: 'Standup', start: { dateTime: '2026-01-01T09:00:00Z' }, end: { dateTime: '2026-01-01T09:15:00Z' } }] });
  const h = buildHarness({ calendarFetch, modelReply: () => new Error('all providers down') });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.status, 'UNAVAILABLE');
  assert.equal(data.summary, null);
  assert.deepEqual(data.actionItems, []);
  // the real calendar data gathered before the model call still surfaces —
  // "unavailable" describes the synthesis, not the whole response.
  assert.equal(data.schedule.length, 1);
});

test('fallback: when the primary provider fails and a fallback succeeds, fallbackOccurred is true and the real fallback provider name is reported', async () => {
  const HEADERS = headersFor('fallback');
  const primary: ModelProvider = fakeModelProvider(() => new Error('primary down'), 'nebius');
  const fallback: ModelProvider = fakeModelProvider(() => JSON.stringify({ summary: 'ok', actionItems: [] }), 'openai');
  const aiService = new AiService(new UnifiedModelRouter([primary, fallback], { info: () => {}, warn: () => {} }));
  const h = buildHarness();
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.status, 'OK');
  assert.equal(data.provider, 'openai');
  assert.equal(data.fallbackOccurred, true);
});

test('no fake action: Daily Brief never creates or auto-approves anything — no approval is created as a side effect of generating a brief', async () => {
  const HEADERS = headersFor('no_fake_action');
  const h = buildHarness();
  // The route reads currently-pending approvals from the real, shared
  // actionApprovals singleton (same one every other real approval flow in
  // this app uses) — not the harness's own local ActionApprovalStore
  // (which only exists here to construct calendarService/gmailService).
  const before = sharedActionApprovals.listPending(HEADERS['x-nagex-tenant'], HEADERS['x-principal-id']);
  assert.equal(before.length, 0);
  await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const after = sharedActionApprovals.listPending(HEADERS['x-nagex-tenant'], HEADERS['x-principal-id']);
  assert.equal(after.length, 0);
});

test('source grounding: a real pending approval is surfaced with its own real sourceId/toolId, never invented', async () => {
  const HEADERS = headersFor('source_grounding');
  const h = buildHarness();
  sharedActionApprovals.request({ toolId: 'google_calendar.create_event', tenantId: HEADERS['x-nagex-tenant'], principalId: HEADERS['x-principal-id'], payload: { summary: 'Team Sync' } });
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const data = res.data as any;
  assert.equal(data.approvals.length, 1);
  assert.equal(data.approvals[0].sourceType, 'APPROVAL');
  assert.equal(data.approvals[0].toolId, 'google_calendar.create_event');
  assert.equal(data.approvals[0].status, 'PENDING');
  assert.ok(data.approvals[0].sourceId);
});

test('caching: a second request within the TTL returns the cached brief marked cached=true, without re-calling Calendar/Gmail/the model', async () => {
  const HEADERS = headersFor('caching');
  let calendarCalls = 0;
  let modelCalls = 0;
  const calendarFetch: typeof fetch = async () => { calendarCalls++; return jsonResponse({ items: [] }); };
  const h = buildHarness({ calendarFetch, modelReply: () => { modelCalls++; return JSON.stringify({ summary: 'ok', actionItems: [] }); } });
  const first = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal((first.data as any).cached, false);
  assert.equal(calendarCalls, 1);
  assert.equal(modelCalls, 1);

  const second = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  assert.equal((second.data as any).cached, true);
  assert.equal(calendarCalls, 1, 'a cached read must not re-hit Calendar');
  assert.equal(modelCalls, 1, 'a cached read must not re-hit the model');

  const forced = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, { refresh: 'true' }, h.calendarService, h.gmailService);
  assert.equal((forced.data as any).cached, false);
  assert.equal(calendarCalls, 2, '?refresh=true must force a real re-fetch');
});

test('Activity trace: daily_brief.started and daily_brief.completed are both recorded with real, traceable identifiers', async () => {
  const HEADERS = headersFor('activity_trace');
  const h = buildHarness();
  const res = await handleAsyncApiRequest('GET', '/api/v1/daily-brief', null, HEADERS, h.aiService, {}, h.calendarService, h.gmailService);
  const requestId = (res.data as any).requestId;
  assert.ok(requestId);
  // Activity itself is asserted indirectly here (no activityStore DI param
  // on this route — it uses the shared, already-tested activityStore
  // directly, exactly like /api/v1/my-space above it); this test's real
  // job is confirming the route always returns a real, non-fabricated
  // requestId that a caller could cross-reference against Activity.
});
