import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoScenarioService } from '../src/demo/demo-scenario.service.js';

test('Demo Reset restores canonical Alex Kim state without touching production stores', () => {
  const demo = new DemoScenarioService();
  const brief = demo.handle('GET', '/api/v1/personal/morning-brief', null)!;
  assert.equal((brief.data as any).persona.name, 'Alex Kim');
  assert.equal((brief.data as any).schedule_summary.count, 3);
  assert.equal((brief.data as any).email_summary.important_count, 1);
  assert.equal((brief.data as any).task_summary.due_today, 1);

  const slots = demo.handle('POST', '/api/v1/tools/google-calendar/free-slots', {})!;
  const slot = (slots.data as any).freeSlots[0];
  const prepared = demo.handle('POST', '/api/v1/approvals', { payload: { summary: 'Client follow-up', start: slot.start, end: slot.end } })!;
  const approvalId = (prepared.data as any).approvalId;
  assert.equal((demo.handle('GET', '/api/v1/demo/state', null)!.data as any).mutationCount, 0, 'preparation must not mutate');

  demo.handle('POST', `/api/v1/approvals/${approvalId}/approve`, {});
  const executed = demo.handle('POST', '/api/v1/tools/google-calendar/create-event', { approvalId })!;
  assert.equal((executed.data as any).status, 'SUCCEEDED');
  assert.equal((demo.handle('GET', '/api/v1/demo/state', null)!.data as any).mutationCount, 1);
  const replay = demo.handle('POST', '/api/v1/tools/google-calendar/create-event', { approvalId })!;
  assert.equal(replay.status, 409, 'approval consumption blocks duplicate mutation');

  demo.handle('POST', '/api/v1/demo/reset', {});
  const reset = demo.handle('GET', '/api/v1/demo/state', null)!;
  assert.equal((reset.data as any).mutationCount, 0);
  assert.deepEqual((reset.data as any).addedEvents, []);
  assert.equal((reset.data as any).approvalCount, 0);
});

test('Quick Wake and Meeting Prep are derived from the canonical demo fixture', () => {
  const demo = new DemoScenarioService();
  const quickWake = demo.handle('GET', '/api/v1/personal/quick-wake', null)!.data as any;
  assert.deepEqual(quickWake.proactive_suggestion.grounded_on.map((item: any) => item.label), ['Last meeting notes', 'Proposal v3', 'Recent email from Sarah']);
  const prep = demo.handle('POST', '/api/v1/personal/meeting-prep', { eventId: 'demo_evt_client' })!.data as any;
  assert.match(prep.key_points.join(' '), /pricing flexibility/i);
  assert.match(prep.key_points.join(' '), /delivery date/i);
  assert.match(prep.key_points.join(' '), /timeline unresolved/i);
  assert.deepEqual(prep.related_materials.map((item: any) => item.type), ['VAULT', 'VAULT', 'EMAIL', 'MEMORY', 'TASK']);
});
