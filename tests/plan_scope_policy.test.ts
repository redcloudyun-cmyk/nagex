import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import type { ModelProvider } from '../src/model-gateway/model-provider.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { googleTokenStore as sharedGoogleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES } from '../src/integrations/google/oauth.client.js';
import { GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/tools/google-calendar.service.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import type { MemoryRecord } from '../src/context/memory.engine.js';

const GRANTED_SCOPE_STRING = GOOGLE_CALENDAR_SCOPES.join(' ');
const NOOP_LOGGER = { info: () => {}, warn: () => {} };

async function withGoogleConnected<T>(fn: () => T | Promise<T>): Promise<T> {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GRANTED_SCOPE_STRING });
  try {
    return await fn();
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
}

const resolver = new PlanResolver(skillRegistry, sharedToolRegistry);

// ── 11.A: simple calendar request ───────────────────────────────────────────

test('A. Simple calendar request: only the Calendar scheduling step is required and it resolves independently', () => withGoogleConnected(() => {
  const plan: PlanPreview = {
    goal: 'Schedule the meeting',
    summary: 'Create the requested calendar event only.',
    reasoningSummary: 'The user asked only for scheduling; nothing else is necessary.',
    suggestions: [],
    steps: [
      { step: 1, title: 'Create calendar event', reasoning: 'Fulfills the explicit scheduling request.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
    ],
  };
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps.length, 1);
  assert.equal(resolved.steps[0].resolvedToolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(resolved.steps[0].toolAvailability, 'AVAILABLE');
  assert.equal(resolved.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
}));

// ── 11.B: "Schedule it and email John" ──────────────────────────────────────

test('B. "Schedule it and email John": Calendar + Gmail, Calendar stays independently approval-required even though Gmail is mock-only', () => withGoogleConnected(() => {
  const plan: PlanPreview = {
    goal: 'Schedule the meeting and email John',
    summary: 'Create the event and email John, as explicitly requested.',
    reasoningSummary: 'Both actions were explicitly requested by the user.',
    suggestions: [],
    steps: [
      { step: 1, title: 'Create calendar event', reasoning: 'Explicitly requested scheduling action.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
      { step: 2, title: 'Email John', reasoning: 'Explicitly requested notification.', skill: 'Email Drafting', tool: 'Gmail', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
    ],
  };
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps.length, 2);
  assert.equal(resolved.steps[0].resolvedToolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(resolved.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(resolved.steps[1].resolvedToolId, 'gmail.send_email');
  assert.equal(resolved.steps[1].toolAvailability, 'MOCK_ONLY');
  assert.equal(resolved.steps[1].executionReadiness, 'BLOCKED');
  // Partial execution safety: Gmail being mock-only must not mask Calendar's
  // own, independently-calculated readiness, nor drag the whole plan BLOCKED.
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
}));

// ── 11.C: "Prepare an agenda and schedule the meeting" ──────────────────────

test('C. "Prepare an agenda and schedule the meeting": agenda preparation + Calendar, both required and both actionable', () => withGoogleConnected(() => {
  const plan: PlanPreview = {
    goal: 'Prepare an agenda and schedule the meeting',
    summary: 'Draft the agenda and create the calendar event, as explicitly requested.',
    reasoningSummary: 'Both actions were explicitly requested by the user.',
    suggestions: [],
    steps: [
      { step: 1, title: 'Prepare meeting agenda', reasoning: 'Explicitly requested agenda preparation.', skill: 'Meeting Preparation', tool: null, requiresApproval: false, necessity: 'REQUIRED', dependsOn: [] },
      { step: 2, title: 'Create calendar event', reasoning: 'Explicitly requested scheduling action.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
    ],
  };
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps.length, 2);
  assert.equal(resolved.steps[0].resolvedSkillId, 'skill.meeting_preparation');
  assert.equal(resolved.steps[0].executionReadiness, 'EXECUTION_READY');
  assert.equal(resolved.steps[1].resolvedToolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(resolved.steps[1].executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
}));

// ── 11.D: "Schedule it and update Notion" ───────────────────────────────────

test('D. "Schedule it and update Notion": Calendar + Notion steps both present', () => withGoogleConnected(() => {
  const plan: PlanPreview = {
    goal: 'Schedule the meeting and update Notion',
    summary: 'Create the event and update the Notion page, as explicitly requested.',
    reasoningSummary: 'Both actions were explicitly requested by the user.',
    suggestions: [],
    steps: [
      { step: 1, title: 'Create calendar event', reasoning: 'Explicitly requested scheduling action.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
      { step: 2, title: 'Update Notion page', reasoning: 'Explicitly requested Notion update.', skill: 'Document Summary', tool: 'Notion', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
    ],
  };
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps.length, 2);
  assert.equal(resolved.steps[0].resolvedToolId, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.equal(resolved.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(resolved.steps[1].resolvedToolId, 'notion.create_page');
  assert.equal(resolved.steps[1].toolAvailability, 'UNAVAILABLE');
  assert.equal(resolved.steps[1].executionReadiness, 'BLOCKED');
}));

// ── 11.E: explicit multi-tool request with unavailable Notion ──────────────

test('E. Explicit multi-tool request with unavailable Notion: Calendar readiness is independent, but a real dependent of the blocked step stays blocked', () => withGoogleConnected(() => {
  const plan: PlanPreview = {
    goal: 'Schedule the meeting, update Notion, and share the page link',
    summary: 'Create the event, update Notion, then share the resulting page link.',
    reasoningSummary: 'Explicitly requested multi-tool workflow.',
    suggestions: [],
    steps: [
      { step: 1, title: 'Create calendar event', reasoning: 'Independent scheduling action.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
      { step: 2, title: 'Update Notion page', reasoning: 'Explicitly requested Notion update.', skill: 'Document Summary', tool: 'Notion', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
      { step: 3, title: 'Share the Notion page link', reasoning: 'Depends on the Notion page existing.', skill: 'Planning', tool: null, requiresApproval: false, necessity: 'REQUIRED', dependsOn: [2] },
    ],
  };
  const resolved = resolver.resolve(plan);

  // Calendar (step 1) has no dependency on the blocked Notion step, so it
  // must keep its own, independently-calculated readiness.
  assert.equal(resolved.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(resolved.steps[0].dependencyBlocked, false);

  // Notion (step 2) is blocked on its own merits (tool unavailable).
  assert.equal(resolved.steps[1].executionReadiness, 'BLOCKED');
  assert.equal(resolved.steps[1].dependencyBlocked, false);

  // Step 3 would otherwise resolve fine (no tool involved), but it
  // explicitly depends on the blocked Notion step, so dependency semantics
  // must block it too — "never execute a step whose required dependency is
  // blocked".
  assert.deepEqual(resolved.steps[2].dependsOn, [2]);
  assert.equal(resolved.steps[2].dependencyBlocked, true);
  assert.equal(resolved.steps[2].executionReadiness, 'BLOCKED');

  // The overall plan status must not be dragged down to BLOCKED just because
  // two of the three required steps are blocked: Calendar is independently
  // approval-required, so that is the plan's actionable status.
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
}));

// ── 11.F: memory must not override explicit current intent ────────────────

test('F. memory contains Acme Corp context but the user requests "NAgex UI Calendar Test": Acme is never injected', async () => {
  const acmeMemory: MemoryRecord = {
    id: 'mem_acme',
    scope: 'USER',
    owner_id: 'usr_admin_001',
    lifecycle: 'ACTIVE',
    content: { subject: 'Acme Corp Context', predicate: 'memory_summary', value: 'Preparing for the Acme Corp quarterly business review.' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  let capturedSystemPrompt = '';
  const compliantProvider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => {
      capturedSystemPrompt = request.messages.find((m) => m.role === 'system')?.content || '';
      return {
        text: JSON.stringify({
          goal: 'Schedule the meeting',
          summary: 'Create a single calendar event as requested.',
          reasoningSummary: 'The user asked only for scheduling; the Acme Corp memory is not relevant here.',
          suggestions: [],
          steps: [
            { title: 'Create calendar event', reasoning: 'Fulfills the explicit scheduling request.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
          ],
        }),
        provider: 'test',
        model: 'test-model',
        latencyMs: 1,
        requestId: request.requestId,
      };
    },
  };
  const service = new AiService(new UnifiedModelRouter([compliantProvider], NOOP_LOGGER));

  const result = await service.plan({
    prompt: 'Schedule a meeting tomorrow at 2 PM for 30 minutes titled "NAgex UI Calendar Test".',
    memories: [acmeMemory],
    mode: 'auto',
  });

  // The scope policy (memory must inform only when relevant, and must never
  // override the current instruction) must actually be present in the
  // system prompt sent to the model.
  assert.match(capturedSystemPrompt, /Do not add consequential actions/i);
  assert.match(capturedSystemPrompt, /Memory must never override, replace, or expand/i);

  assert.equal(result.data.steps.length, 1);
  assert.equal(result.data.steps[0].tool, GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.ok(!result.data.steps.some((s) => /acme/i.test(s.title) || /acme/i.test(s.reasoning)));
  assert.ok(!/acme/i.test(result.data.goal) && !/acme/i.test(result.data.summary));
});

// ── item 12: regression test for the exact live prompt ─────────────────────

test('regression: "Schedule a meeting tomorrow at 2 PM for 30 minutes titled \'NAgex UI Calendar Test\'." produces only the Calendar step', async () => withGoogleConnected(async () => {
  const compliantProvider: ModelProvider = {
    name: 'test',
    model: 'test-model',
    status: () => ({ configured: true, available: true, provider: 'test', model: 'test-model' }),
    generate: async (request) => ({
      text: JSON.stringify({
        goal: 'Schedule the NAgex UI Calendar Test meeting',
        summary: 'Create the requested calendar event only.',
        reasoningSummary: 'The user asked only for scheduling; nothing else is necessary.',
        suggestions: [],
        steps: [
          { title: 'Create calendar event', reasoning: 'Fulfills the explicit scheduling request.', skill: 'Scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] },
        ],
      }),
      provider: 'test',
      model: 'test-model',
      latencyMs: 1,
      requestId: request.requestId,
    }),
  };
  const service = new AiService(new UnifiedModelRouter([compliantProvider], NOOP_LOGGER));

  const intentRes = await handleAsyncApiRequest(
    'POST',
    '/api/v1/ambient/intent',
    { prompt: "Schedule a meeting tomorrow at 2 PM for 30 minutes titled 'NAgex UI Calendar Test'." },
    { 'x-request-id': 'req_regression_1' },
    service,
  );
  assert.equal(intentRes.status, 200);
  const plan = (intentRes.data as { plan: PlanPreview }).plan;

  const toolIds = plan.steps.map((s) => s.tool);
  assert.ok(toolIds.includes(GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID), 'expected google_calendar.create_event to be present');
  assert.ok(!toolIds.some((t) => t === 'notion.create_page' || /notion/i.test(String(t))), 'expected no notion.create_page step');
  assert.ok(!toolIds.some((t) => t === 'gmail.send_email' || /gmail/i.test(String(t))), 'expected no gmail.send_email step');
  assert.ok(!plan.steps.some((s) => /slack/i.test(s.title) || /slack/i.test(String(s.tool))), 'expected no Slack tool/step');
  assert.ok(!plan.steps.some((s) => /research/i.test(s.title) || /research/i.test(s.skill)), 'expected no unrelated research step');

  const resolveRes = await handleAsyncApiRequest('POST', '/api/v1/plans/resolve', { plan });
  assert.equal(resolveRes.status, 200);
  const resolved = resolveRes.data as { status: string; steps: Array<{ resolvedToolId: string | null; executionReadiness: string }> };
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');

  const calendarStep = resolved.steps.find((s) => s.resolvedToolId === GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID);
  assert.ok(calendarStep, 'expected the resolved plan to contain the Calendar step');
  // "Calendar approval UI available": this is the exact condition app.js's
  // resolvePlanIntoUi checks to render the approval card instead of a
  // "Cannot Execute" banner or a connect-Google-Calendar prompt.
  assert.equal(calendarStep!.executionReadiness, 'APPROVAL_REQUIRED');
}));
