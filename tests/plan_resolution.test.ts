import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry, ToolRegistry } from '../src/tools/tool-registry.js';
import { AiService, type PlanPreview } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { NagexError } from '../src/common/errors.js';
import { handleAsyncApiRequest } from '../src/server_web.js';

const resolver = new PlanResolver(skillRegistry, toolRegistry);

function planFor(tool: string | null, skill = 'Planning', requiresApproval = false): PlanPreview {
  return {
    goal: 'Prepare safely',
    summary: 'A preparation-only plan.',
    reasoningSummary: 'Resolve registry identities before execution.',
    steps: [{ step: 1, title: 'Prepare step', reasoning: 'Test resolution.', skill, tool, requiresApproval }],
  };
}

test('plan resolver resolves an exact canonical tool ID', () => {
  const step = resolver.resolve(planFor('google_calendar.create_event', 'Scheduling')).steps[0];
  assert.equal(step.resolvedToolId, 'google_calendar.create_event');
  assert.equal(step.toolResolutionStatus, 'RESOLVED');
});

test('plan resolver resolves safe aliases to canonical tool and skill IDs', () => {
  const step = resolver.resolve(planFor('Google Calendar', 'Meeting Prep')).steps[0];
  assert.equal(step.resolvedToolId, 'google_calendar.create_event');
  assert.equal(step.resolvedSkillId, 'skill.meeting_preparation');
});

test('unknown and hallucinated tool names remain unresolved and blocked', () => {
  for (const name of ['unknown.tool', 'gmail.delete_everything']) {
    const step = resolver.resolve(planFor(name)).steps[0];
    assert.equal(step.toolResolutionStatus, 'UNRESOLVED');
    assert.equal(step.resolvedToolId, null);
    assert.equal(step.executionReadiness, 'BLOCKED');
  }
});

test('unavailable registered tool is resolved but blocked', () => {
  const step = resolver.resolve(planFor('notion.create_page', 'Document Summary')).steps[0];
  assert.equal(step.resolvedToolId, 'notion.create_page');
  assert.equal(step.toolAvailability, 'UNAVAILABLE');
  assert.equal(step.executionReadiness, 'BLOCKED');
});

test('mock registered tools are never treated as live or execution-ready', () => {
  // Gmail is now a real LIVE-or-unavailable tool (no mock state — see
  // tool-registry.ts's gmailLiveStatus), so this test exercises the
  // registry's generic mock handling against a throwaway mock-mode tool
  // instead of depending on which specific tool happens to be mocked today.
  const mockOnlyRegistry = new ToolRegistry([
    { id: 'demo.mock_tool', name: 'Demo Mock Tool', capability: 'demo.mock', connectionStatus: 'connected', sideEffectLevel: 'IRREVERSIBLE_WRITE', requiresApproval: true, executionMode: 'mock', aliases: ['demo mock tool'] },
  ]);
  const mockResolver = new PlanResolver(skillRegistry, mockOnlyRegistry);
  const step = mockResolver.resolve(planFor('demo.mock_tool', 'Email Drafting')).steps[0];
  assert.equal(step.resolvedToolId, 'demo.mock_tool');
  assert.equal(step.toolAvailability, 'MOCK_ONLY');
  assert.equal(step.executionReadiness, 'BLOCKED');
});

test('a live reversible write requires human approval', () => {
  const step = resolver.resolve(planFor('workspace.prepare_draft', 'Planning')).steps[0];
  assert.equal(step.sideEffectLevel, 'REVERSIBLE_WRITE');
  assert.equal(step.approvalRequired, true);
  assert.equal(step.executionReadiness, 'APPROVAL_REQUIRED');
});

test('a registered live read-only tool can become execution-ready', () => {
  const step = resolver.resolve(planFor('memory.search', 'Memory Recall')).steps[0];
  assert.equal(step.sideEffectLevel, 'READ_ONLY');
  assert.equal(step.approvalRequired, false);
  assert.equal(step.executionReadiness, 'EXECUTION_READY');
});

test('unresolved skills fail closed even when the tool is safe', () => {
  const step = resolver.resolve(planFor('memory.search', 'Imaginary Omnipotent Skill')).steps[0];
  assert.equal(step.skillResolutionStatus, 'UNRESOLVED');
  assert.equal(step.resolvedSkillId, null);
  assert.equal(step.executionReadiness, 'BLOCKED');
});

test('POST /api/v1/plans/resolve returns preparation status without executing', async () => {
  const response = await handleAsyncApiRequest('POST', '/api/v1/plans/resolve', { plan: planFor('workspace.prepare_draft') });
  assert.equal(response.status, 200);
  const resolved = response.data as { status: string; steps: Array<{ resolvedToolId: string; executionReadiness: string }> };
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
  assert.equal(resolved.steps[0].resolvedToolId, 'workspace.prepare_draft');
  assert.equal(resolved.steps[0].executionReadiness, 'APPROVAL_REQUIRED');
});

// ─── P01a — Plan Step Parameters ────────────────────────────────────────
//
// PlanStep gained an opaque `parameters?: Record<string, unknown>` field:
// planning infrastructure never interprets its contents, only validates
// that a *present* value is a plain object, and passes it through
// unchanged. These tests cover both entry points — the model-response
// path (AiService.plan() -> normalizePlan()) and the direct/hand-built
// PlanPreview path (PlanResolver.resolve(), e.g. POST /api/v1/plans/resolve).

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// A single-provider AiService whose one provider always returns exactly
// `rawPlan` as the model's JSON text — mirrors this repo's established
// mock-model pattern (see tests/candidate_model.test.ts's buildMockAiService).
function aiServiceReturning(rawPlan: unknown): AiService {
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'test-plan-model' },
    async () => jsonResponse({ output_text: JSON.stringify(rawPlan) }),
  );
  return new AiService(new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} }));
}

const validRawPlanBase = {
  goal: 'Check availability',
  summary: 'Look up free calendar slots.',
  reasoningSummary: 'A single read-only lookup satisfies the request.',
  suggestions: [],
};

function rawStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'Check free/busy',
    reasoning: 'Directly satisfies the request.',
    skill: 'skill.scheduling',
    tool: 'google_calendar.free_slots',
    requiresApproval: false,
    necessity: 'REQUIRED',
    dependsOn: [],
    ...overrides,
  };
}

test('P01a-1: a model response with parameters round-trips into PlanStep and ResolvedPlanStep unchanged', async () => {
  const params = { timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2026-10-01T23:59:59.000Z', calendarId: 'primary' };
  const aiService = aiServiceReturning({ ...validRawPlanBase, steps: [rawStep({ parameters: params })] });
  const planResponse = await aiService.plan({ prompt: 'x', memories: [], mode: 'auto' });
  assert.deepEqual(planResponse.data.steps[0].parameters, params, 'PlanPreview must carry parameters through unchanged');

  const resolved = resolver.resolve(planResponse.data);
  assert.deepEqual(resolved.steps[0].parameters, params, 'ResolvedPlanStep must preserve parameters unchanged');
});

test('P01a-2: omitted parameters normalizes to {} on the model-response path', async () => {
  const aiService = aiServiceReturning({ ...validRawPlanBase, steps: [rawStep({})] });
  const planResponse = await aiService.plan({ prompt: 'x', memories: [], mode: 'auto' });
  assert.deepEqual(planResponse.data.steps[0].parameters, {});
});

test('P01a-3/4/5: a present but malformed model-response parameters value (primitive/null/array) fails closed with INVALID_MODEL_RESPONSE', async () => {
  for (const malformed of ['a string', null, ['not', 'an', 'object']]) {
    const aiService = aiServiceReturning({ ...validRawPlanBase, steps: [rawStep({ parameters: malformed })] });
    await assert.rejects(
      () => aiService.plan({ prompt: 'x', memories: [], mode: 'auto' }),
      (err: unknown) => {
        if (!(err instanceof NagexError)) return false;
        // The single configured provider's own validation failure is
        // caught and wrapped by UnifiedModelRouter (its candidate list is
        // then exhausted) — the real, observable end-to-end behavior for a
        // malformed model response, not just the inner function's return.
        const failures = (err.details as { failures?: Array<{ code: string }> } | undefined)?.failures;
        return Boolean(failures?.some((f) => f.code === 'INVALID_MODEL_RESPONSE'));
      },
    );
  }
});

test('P01a-6: a direct/hand-built PlanPreview with malformed present parameters fails PlanResolver\'s structural gate with INVALID_PLAN_STEP', () => {
  for (const malformed of ['a string', null, ['not', 'an', 'object']]) {
    const plan: PlanPreview = { ...planFor('google_calendar.free_slots', 'Scheduling'), steps: [{ ...planFor('google_calendar.free_slots').steps[0], parameters: malformed as unknown as Record<string, unknown> }] };
    assert.throws(() => resolver.resolve(plan), (err: unknown) => err instanceof NagexError && err.code === 'INVALID_PLAN_STEP');
  }
});

test('P01a-7: arbitrary nested content inside a valid parameters object passes through structurally unchanged', () => {
  const nested = { filters: { status: ['open', 'pending'], range: { from: '2026-01-01', to: '2026-12-31' } }, limit: 5, tags: ['a', 'b'] };
  const plan: PlanPreview = { ...planFor('google_calendar.free_slots', 'Scheduling'), steps: [{ ...planFor('google_calendar.free_slots').steps[0], parameters: nested }] };
  const resolved = resolver.resolve(plan);
  assert.deepEqual(resolved.steps[0].parameters, nested);
});

test('P01a-8: PlanResolver never inspects or mutates parameters content, regardless of what keys it contains', () => {
  const arbitrary = { anythingAtAll: 42, evenUnrelatedToAnyCapability: { deeply: { nested: true } } };
  const plan: PlanPreview = { ...planFor('unknown.tool'), steps: [{ ...planFor('unknown.tool').steps[0], parameters: arbitrary }] };
  // Even a step whose tool is unresolved/blocked must still carry its
  // parameters through untouched — PlanResolver's blocking logic is
  // entirely orthogonal to parameters.
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps[0].executionReadiness, 'BLOCKED');
  assert.deepEqual(resolved.steps[0].parameters, arbitrary);
});

test('P01a-9: a hand-built PlanPreview step with parameters entirely omitted resolves without error (undefined, not defaulted, on the direct path)', () => {
  const plan = planFor('memory.search', 'Memory Recall');
  const resolved = resolver.resolve(plan);
  assert.equal(resolved.steps[0].parameters, undefined, 'the direct path performs structural validation only, never defaults an absent value — only the model-response path (normalizePlan) normalizes missing to {}');
});
