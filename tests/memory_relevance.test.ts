import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';

const NOOP_LOGGER = { info: () => {}, warn: () => {} };

// These tests exercise the REAL production seed memory in server_web.ts
// (which includes a pinned "Acme Corp Context" memory, matching the exact
// live bug report) through the real getRelevantMemories() retrieval logic —
// only the model provider is mocked, so what's asserted here is what the
// server actually assembles as "Relevant memory" context for the model,
// not a hand-picked test fixture.
function buildCapturingService(capture: { userContent: string }) {
  const provider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => {
      capture.userContent = request.messages.find((m) => m.role === 'user')?.content || '';
      return {
        text: JSON.stringify({
          goal: 'Schedule the meeting',
          summary: 'Create the requested calendar event only.',
          reasoningSummary: 'The user asked only for scheduling; nothing else is necessary.',
          suggestions: [],
          steps: [
            { title: 'Create calendar event', reasoning: 'Fulfills the explicit scheduling request.', skill: 'skill.scheduling', tool: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
          ],
        }),
        provider: 'test',
        model: 'test-model',
        latencyMs: 1,
        requestId: request.requestId,
      };
    },
  };
  return new AiService(new UnifiedModelRouter([provider], NOOP_LOGGER));
}

test('E. a generic "next client meeting" request does not surface the seeded, pinned Acme Corp memory as relevant context', async () => {
  const capture = { userContent: '' };
  const service = buildCapturingService(capture);
  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ambient/intent',
    { prompt: 'Prepare my next client meeting and schedule it.' },
    { 'x-principal-id': 'usr_admin_001' },
    service,
  );
  assert.equal(res.status, 200);
  const memorySection = capture.userContent.split('Relevant memory:')[1] || '';
  assert.doesNotMatch(memorySection, /acme/i);
});

test('F. an explicit "Schedule the Acme Corp QBR" request may surface the Acme Corp memory as relevant context', async () => {
  const capture = { userContent: '' };
  const service = buildCapturingService(capture);
  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ambient/intent',
    { prompt: 'Schedule the Acme Corp QBR.' },
    { 'x-principal-id': 'usr_admin_001' },
    service,
  );
  assert.equal(res.status, 200);
  const memorySection = capture.userContent.split('Relevant memory:')[1] || '';
  assert.match(memorySection, /acme/i);
});

test('G. the exact live regression prompt never surfaces Acme Corp memory, even though it is seeded and pinned', async () => {
  const capture = { userContent: '' };
  const service = buildCapturingService(capture);
  const res = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ambient/intent',
    { prompt: "Schedule a meeting tomorrow at 2 PM for 30 minutes titled 'NAgex UI Calendar Test'." },
    { 'x-principal-id': 'usr_admin_001' },
    service,
  );
  assert.equal(res.status, 200);
  const memorySection = capture.userContent.split('Relevant memory:')[1] || '';
  assert.doesNotMatch(memorySection, /acme/i);

  const plan = (res.data as { plan: { steps: Array<{ tool: string | null; title: string; skill: string }> } }).plan;
  assert.ok(!plan.steps.some((s) => /notion|gmail|slack/i.test(String(s.tool)) || /notion|gmail|slack/i.test(s.title)));
});
