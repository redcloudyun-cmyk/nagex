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
  console.log('DEMO_MEETING_PREP_VAULT_REFERENCES_VALID=PASS');
  console.log('R21_P1_DEMO_SCENARIO=PASS');
});

test('Demo Vault scenario aligns strictly with canonical VaultItem public contract', () => {
  const demo = new DemoScenarioService();

  // 1. GET /api/v1/workspace/vault
  const getRes = demo.handle('GET', '/api/v1/workspace/vault', null)!;
  assert.equal(getRes.status, 200);
  const data = getRes.data as any;

  assert.ok(Array.isArray(data.items), 'items must be an array');
  assert.ok(Array.isArray(data.recentItems), 'recentItems must be an array');
  assert.equal(typeof data.total, 'number');
  assert.equal(typeof data.usedSizeBytes, 'number');
  assert.equal(data.quotaSizeBytes, 10737418240);
  assert.equal(data.query, null);
  assert.deepEqual(data.storageInfo, { provider: 'local', isCloud: false, label: 'NAgex Personal Vault' });
  console.log('DEMO_VAULT_SUMMARY_CONTRACT=PASS');

  // Verify canonical VaultItem shape on each item
  const itemIds: string[] = [];
  data.items.forEach((item: any) => {
    itemIds.push(item.vaultItemId);
    assert.ok(typeof item.vaultItemId === 'string', 'vaultItemId must be string');
    assert.ok(typeof item.userId === 'string', 'userId must be string');
    assert.ok(typeof item.tenantId === 'string', 'tenantId must be string');
    assert.ok(typeof item.workspaceId === 'string', 'workspaceId must be string');
    assert.ok(typeof item.type === 'string', 'type must be string');
    assert.ok(typeof item.title === 'string', 'title must be string');
    assert.ok(typeof item.mimeType === 'string', 'mimeType must be string');
    assert.ok(typeof item.storageRef === 'string', 'storageRef must be string');
    assert.ok(typeof item.source === 'string', 'source must be string');
    assert.ok(typeof item.metadata === 'object', 'metadata must be object');
    assert.ok(typeof item.createdAt === 'string', 'createdAt must be string');
    assert.ok(typeof item.updatedAt === 'string', 'updatedAt must be string');
    assert.equal(item.id, undefined, 'legacy id field must not exist at root');
    assert.equal(item.content, undefined, 'legacy content field must not exist at root');
  });
  console.log('DEMO_VAULT_CANONICAL_ITEM_SHAPE=PASS');

  // Verify stable IDs
  assert.ok(itemIds.includes('demo_vault_proposal'), 'demo_vault_proposal ID must exist');
  assert.ok(itemIds.includes('demo_vault_notes'), 'demo_vault_notes ID must exist');
  console.log('DEMO_VAULT_STABLE_IDS=PASS');

  // 2. POST /api/v1/workspace/vault
  const postRes = demo.handle('POST', '/api/v1/workspace/vault', {
    title: 'New Demo Note',
    type: 'SAVED_ANALYSIS',
    source: 'USER_SAVE',
    metadata: { summary: 'Custom saved note' }
  })!;

  assert.equal(postRes.status, 201);
  const newItem = postRes.data as any;
  assert.equal(newItem.vaultItemId, 'demo_vault_saved_1');
  assert.equal(newItem.title, 'New Demo Note');
  assert.equal(newItem.type, 'SAVED_ANALYSIS');
  assert.equal(newItem.source, 'USER_SAVE');
  assert.equal(newItem.metadata.summary, 'Custom saved note');
  assert.ok(typeof newItem.createdAt === 'string');
  assert.ok(typeof newItem.updatedAt === 'string');
  console.log('DEMO_VAULT_POST_CANONICAL_SHAPE=PASS');
});
