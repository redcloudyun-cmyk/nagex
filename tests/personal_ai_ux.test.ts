import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleApiRequest, handleAsyncApiRequest } from '../src/server_web.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { ToolInvoker } from '../src/agent/tool.invoker.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';

function validCalendarPayload(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'primary',
    summary: 'Client Strategy Sync',
    description: 'Quarterly strategy discussion.',
    start: '2026-10-01T17:00:00.000Z',
    end: '2026-10-01T17:30:00.000Z',
    timezone: 'America/Los_Angeles',
    attendees: ['client@example.com'],
    conferenceData: false,
    ...overrides,
  };
}

const planningProvider: ModelProvider = {
  name: 'openai',
  model: 'test-openai-model',
  // This fixture returns a structured JSON plan regardless of its 'openai'
  // name — it is a fake provider, not the real OpenAIProvider (whose actual
  // capability declaration in src/model-gateway/providers.ts is untouched
  // and correctly false for JSON/structured), so its capabilities must
  // truthfully reflect what it actually does: structured plan generation.
  capabilities: { provider: 'openai', supportsJsonMode: true, supportsGeneralChat: true, supportsStructuredExtraction: true },
  status: () => ({ configured: true, available: true, provider: 'openai', model: 'test-openai-model', status: 'LIVE' as const, lastCheckedAt: null, degradedReason: null }),
  generate: async (request) => ({
    text: JSON.stringify({
      goal: 'Prepare my next client meeting and schedule it.',
      summary: 'Prepare the meeting and draft a scheduling action for later approval.',
      reasoningSummary: 'Use relevant client context before proposing any external action.',
      steps: [
        { title: 'Recall client context', reasoning: 'Ground the plan in memory.', skill: 'Memory Recall', tool: null, requiresApproval: false },
        { title: 'Draft calendar event', reasoning: 'Prepare but do not create the event.', skill: 'Scheduling', tool: 'Google Calendar', requiresApproval: true },
      ],
    }),
    provider: 'openai',
    model: 'test-openai-model',
    latencyMs: 4,
    requestId: request.requestId,
  }),
};
const planningService = new AiService(new UnifiedModelRouter([planningProvider], { info: () => {}, warn: () => {} }));

test('1. Personal AI: Memory CRUD Operations & State Lifecycles', () => {
  const memEngine = new MemoryEngine({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-ux-test-mem-')) });

  const rec = memEngine.proposeMemory('USER', 'ten_ux_test', 'usr_admin_001', {
    subject: 'Client Meeting Time',
    predicate: 'preference',
    value: 'Morning slots preferred',
  });
  assert.strictEqual(rec.lifecycle, 'PROPOSED');
  assert.strictEqual(rec.scope, 'USER');

  const activeRec = memEngine.activateMemory(rec.id, 'ten_ux_test', 'usr_admin_001');
  assert.strictEqual(activeRec.lifecycle, 'ACTIVE');

  const memories = memEngine.getActiveMemories('USER', 'ten_ux_test', 'usr_admin_001');
  assert.strictEqual(memories.length, 1);
  assert.strictEqual(memories[0].id, rec.id);
});

test('2. Personal AI: API GET /api/v1/memory returns active memories', async () => {
  const res = await handleApiRequest('GET', '/api/v1/memory', null);
  assert.strictEqual(res.status, 200);
  const data = res.data as { memories: Array<any>; total: number };
  assert.ok(Array.isArray(data.memories));
  assert.ok(data.memories.length > 0);
  assert.ok(data.memories.some((m) => m.content.subject === 'User Profile'));
});

test('3. Personal AI: API POST /api/v1/memory creates and activates new memory', async () => {
  const newMem = {
    scope: 'USER',
    subject: 'Working Hours',
    predicate: 'is',
    value: '9 AM to 6 PM',
    pinned: true,
  };
  const res = await handleApiRequest('POST', '/api/v1/memory', newMem);
  assert.strictEqual(res.status, 201);
  const data = res.data as { id: string; lifecycle: string; pinned: boolean };
  assert.strictEqual(data.lifecycle, 'ACTIVE');
  assert.strictEqual(data.pinned, true);
});

test('3b. Personal AI: DELETE /api/v1/memory/:id permanently removes the record, not just its pin', async () => {
  const created = await handleApiRequest('POST', '/api/v1/memory', { scope: 'USER', subject: 'Temp Note', predicate: 'is', value: 'delete me' });
  const memId = (created.data as { id: string }).id;

  const deleted = await handleApiRequest('DELETE', `/api/v1/memory/${memId}`, null);
  assert.strictEqual(deleted.status, 200);

  const listing = await handleApiRequest('GET', '/api/v1/memory', null);
  const memories = (listing.data as { memories: Array<{ id: string }> }).memories;
  assert.ok(!memories.some((m) => m.id === memId));

  const deletedAgain = await handleApiRequest('DELETE', `/api/v1/memory/${memId}`, null);
  assert.strictEqual(deletedAgain.status, 404);
});

test('4. Personal AI: Tool Invoker Autonomy & Human Approval Gate', async () => {
  const invoker = new ToolInvoker();
  invoker.registerTool({
    id: 'send_external_email',
    name: 'Gmail Send',
    side_effect: 'IRREVERSIBLE_WRITE',
    handler: async (p) => ({ sent: true, recipient: (p as any).to }),
  });

  await assert.rejects(
    () => invoker.invokeTool('send_external_email', { to: 'client@company.com' }, 'L1', true),
    (err: any) => err.code === 'AUTONOMY_LEVEL_EXCEEDED'
  );

  await assert.rejects(
    () => invoker.invokeTool('send_external_email', { to: 'client@company.com' }, 'L2', false),
    (err: any) => err.code === 'APPROVAL_REQUIRED'
  );

  const res = await invoker.invokeTool('send_external_email', { to: 'client@company.com' }, 'L2', true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual((res.output as any).sent, true);
});

test('5. Personal AI: Ambient Intent returns a real model-backed Plan Preview', async () => {
  const payload = {
    prompt: 'Prepare my next client meeting and schedule it.',
  };
  const res = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', payload, { 'x-request-id': 'req_plan_preview' }, planningService);
  assert.strictEqual(res.status, 200);
  const data = res.data as { status: string; provider: string; model: string; requestId: string; plan: any };
  assert.strictEqual(data.status, 'PLAN_PREVIEW');
  assert.strictEqual(data.provider, 'openai');
  assert.strictEqual(data.model, 'test-openai-model');
  assert.strictEqual(data.requestId, 'req_plan_preview');
  assert.ok(data.plan);
  assert.strictEqual(data.plan.steps.length, 2);
  assert.strictEqual(data.plan.steps[1].requiresApproval, true);
});

test('6. Personal AI: Ambient Intent never accepts an approval shortcut or executes tools', async () => {
  const res = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'Schedule it.', approved: true }, {}, planningService);
  const data = res.data as Record<string, unknown>;
  assert.strictEqual(data.status, 'PLAN_PREVIEW');
  assert.strictEqual(data.execution, undefined);
  assert.strictEqual(data.memory_updated, undefined);
});

// R12.1 Increment 2.5 (DEBT-0006 closure) — these two tests used to hit a
// hardcoded demo/seed approval queue (appr_gcal_sync/appr_stakeholder_email)
// that never reflected real Calendar/Gmail state. That array is gone;
// /api/v1/approvals/:id/action now only ever operates on real
// ActionApprovalStore records, so each test creates one first.
test('7. Personal AI: Approval Queue Handling (Approve Action)', async () => {
  const created = await handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: validCalendarPayload(),
  });
  assert.strictEqual(created.status, 201);
  const approvalId = (created.data as { approvalId: string }).approvalId;

  const res = await handleApiRequest('POST', `/api/v1/approvals/${approvalId}/action`, { action: 'APPROVE' });
  assert.strictEqual(res.status, 200);
  const data = res.data as { approvalId: string; status: string };
  assert.strictEqual(data.approvalId, approvalId);
  assert.strictEqual(data.status, 'APPROVED');
});

test('8. Personal AI: Approval Queue Handling (Reject Action)', async () => {
  const created = await handleApiRequest('POST', '/api/v1/approvals', {
    toolId: GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID,
    payload: validCalendarPayload({ summary: 'Stakeholder Review' }),
  });
  assert.strictEqual(created.status, 201);
  const approvalId = (created.data as { approvalId: string }).approvalId;

  const res = await handleApiRequest('POST', `/api/v1/approvals/${approvalId}/action`, { action: 'REJECT' });
  assert.strictEqual(res.status, 200);
  const data = res.data as { approvalId: string; status: string };
  assert.strictEqual(data.status, 'REJECTED');
});

test('9. Personal AI: Quick Wake & Autonomy Configuration Endpoints', async () => {
  let res = await handleApiRequest('GET', '/api/v1/quickwake/config', null);
  assert.strictEqual(res.status, 200);
  let data = res.data as { floating_button: boolean; fingerprint_button: any };
  assert.strictEqual(data.floating_button, true);
  assert.strictEqual(data.fingerprint_button.supported, false);

  res = await handleApiRequest('POST', '/api/v1/autonomy/config', { level: 'L3' });
  assert.strictEqual(res.status, 200);
  data = res.data as any;
  assert.strictEqual((data as any).level, 'L3');
});
