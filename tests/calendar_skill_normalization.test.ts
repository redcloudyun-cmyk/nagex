import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry as sharedToolRegistry } from '../src/tools/tool-registry.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { googleTokenStore as sharedGoogleTokenStore, DEFAULT_GOOGLE_TENANT_ID } from '../src/integrations/google/token.store.js';
import { GOOGLE_CALENDAR_SCOPES } from '../src/integrations/google/oauth.client.js';
import { GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID } from '../src/modules/calendar/index.js';
import type { PlanPreview } from '../src/model-gateway/ai-service.js';

const GRANTED_SCOPE_STRING = GOOGLE_CALENDAR_SCOPES.join(' ');

async function withGoogleConnected<T>(fn: () => T | Promise<T>): Promise<T> {
  sharedGoogleTokenStore.save(DEFAULT_GOOGLE_TENANT_ID, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GRANTED_SCOPE_STRING });
  try {
    return await fn();
  } finally {
    sharedGoogleTokenStore.clear(DEFAULT_GOOGLE_TENANT_ID);
  }
}

const resolver = new PlanResolver(skillRegistry, sharedToolRegistry);

// ── 10.A/B/C: SkillRegistry alias table ─────────────────────────────────────

test('A. "calendar.create" resolves to the canonical skill.scheduling', () => {
  const resolved = skillRegistry.resolve('calendar.create');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedSkillId, 'skill.scheduling');
});

for (const alias of ['calendar.schedule', 'calendar.scheduling', 'Meeting Scheduling', 'schedule meeting', 'Scheduling']) {
  test(`known scheduling synonym "${alias}" resolves to skill.scheduling`, () => {
    const resolved = skillRegistry.resolve(alias);
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(resolved.resolvedSkillId, 'skill.scheduling');
  });
}

test('B. "Calendar Scheduling" resolves to the canonical skill.scheduling', () => {
  const resolved = skillRegistry.resolve('Calendar Scheduling');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedSkillId, 'skill.scheduling');
});

test('C. an unknown, unrelated skill remains UNRESOLVED (no fuzzy matching)', () => {
  const resolved = skillRegistry.resolve('quantum flux capacitor tuning');
  assert.equal(resolved.status, 'UNRESOLVED');
  assert.equal(resolved.resolvedSkillId, null);
});

test('C. "calendar.delete" must NOT be silently mapped to scheduling merely because it starts with "calendar"', () => {
  const resolved = skillRegistry.resolve('calendar.delete');
  assert.equal(resolved.status, 'UNRESOLVED');
  assert.equal(resolved.resolvedSkillId, null);
});

// ── 10.D: the semantic-variant skill no longer blocks Calendar resolution ──

function planWith(skill: string, tool: string): PlanPreview {
  return {
    goal: 'Schedule the meeting',
    summary: 'Create the requested calendar event only.',
    reasoningSummary: 'The user asked only for scheduling.',
    suggestions: [],
    steps: [{ step: 1, title: 'Create calendar event', reasoning: 'Fulfills the explicit scheduling request.', skill, tool, requiresApproval: true, necessity: 'REQUIRED', dependsOn: [] }],
  };
}

test('D. a plan step using the semantic variant "calendar.create" resolves to APPROVAL_REQUIRED, not BLOCKED', () => withGoogleConnected(() => {
  const resolved = resolver.resolve(planWith('calendar.create', GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID));
  const step = resolved.steps[0];
  assert.equal(step.skillResolutionStatus, 'RESOLVED');
  assert.equal(step.resolvedSkillId, 'skill.scheduling');
  assert.equal(step.toolAvailability, 'AVAILABLE');
  assert.equal(step.executionReadiness, 'APPROVAL_REQUIRED');
  assert.equal(step.warnings.length, 0, 'expected no "Unregistered skill" warning');
  assert.equal(resolved.status, 'APPROVAL_REQUIRED');
}));

test('an unrelated unresolved skill still fails closed even for an otherwise-available Calendar tool', () => withGoogleConnected(() => {
  const resolved = resolver.resolve(planWith('quantum flux capacitor tuning', GOOGLE_CALENDAR_CREATE_EVENT_TOOL_ID));
  const step = resolved.steps[0];
  assert.equal(step.skillResolutionStatus, 'UNRESOLVED');
  assert.equal(step.executionReadiness, 'BLOCKED');
}));
