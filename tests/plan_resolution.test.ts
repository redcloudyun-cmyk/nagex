import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry, ToolRegistry } from '../src/tools/tool-registry.js';
import type { PlanPreview } from '../src/model-gateway/ai-service.js';
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
