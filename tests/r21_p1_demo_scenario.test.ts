import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoScenarioService } from '../src/demo/demo-scenario.service.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

test('Demo Reset restores canonical Alex Kim state without touching production stores', () => {
  const demo = new DemoScenarioService();
  // R23.3 — morning-brief is no longer served by DemoScenarioService (see
  // its own handle()'s header comment); /api/v1/demo/state is still its
  // own real seed/reset/state responsibility and still carries the
  // canonical persona.
  const state0 = demo.handle('GET', '/api/v1/demo/state', null)!;
  assert.equal((state0.data as any).persona.name, 'Alex Kim');

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

// R23.3 — Quick Wake and Meeting Prep are no longer served by
// DemoScenarioService at all (see its own handle()'s header comment) —
// they now reach the real PersonalAssistantEngine, wired to the same
// demo-tenant-aware Calendar/Gmail sources and real seeded Vault/Approval
// records DemoCanonicalSeedService creates (DEMO_PROACTIVE_PARALLEL_PATH=0).
test('Quick Wake and Meeting Prep for the demo tenant use the real canonical PersonalAssistantEngine pipeline', async () => {
  const demoTenantId = 'ten_demo_hackathon';
  const demoOwnerId = 'usr_demo_alex';
  const app = createNagexApplication();

  const quickWake = await app.personalAssistantEngine.executeQuickWake(demoOwnerId, demoTenantId);
  // The demo client meeting is always in progress right now (R23.2D's
  // relative-offset design), so a real grounded suggestion always exists.
  assert.ok(quickWake.proactive_suggestion, 'a real grounded proactive suggestion must be produced for the demo tenant');
  assert.equal(quickWake.proactive_suggestion?.event_id, 'demo_evt_client');
  assert.ok(quickWake.proactive_suggestion!.grounded_on.length > 0);

  const prep = await app.personalAssistantEngine.generateMeetingPrepCard(demoOwnerId, 'demo_evt_client', demoTenantId);
  assert.equal(prep.event_id, 'demo_evt_client');
  assert.ok(prep.related_materials.some((m) => m.type === 'VAULT'), 'the real seeded Vault items must be found');
  assert.ok(prep.related_materials.some((m) => m.type === 'EMAIL'), 'the real demo Gmail thread must be found');
  console.log('DEMO_PROACTIVE_CANONICAL_PIPELINE=PASS');
  console.log('R21_P1_DEMO_SCENARIO=PASS');
});

test('Demo reset reseeds the canonical MemoryEngine record through the demo-domain owner', () => {
  const app = createNagexApplication();
  const tenantId = 'ten_demo_hackathon';
  const ownerId = 'usr_demo_alex';
  const findDemoMemory = () => app.memoryEngine.getActiveMemories('USER', tenantId, ownerId).find(
    (memory) => memory.content.subject === 'Meeting brief preference' && memory.content.predicate === 'prefers',
  );

  const seeded = findDemoMemory();
  assert.ok(seeded);
  app.memoryEngine.deleteMemory(seeded.id, tenantId, ownerId);
  assert.equal(findDemoMemory(), undefined);

  const reset = app.demoScenarioService.handle('POST', '/api/v1/demo/reset', {}, {
    'x-nagex-tenant': tenantId,
    'x-principal-id': ownerId,
  });
  assert.equal(reset?.status, 200);

  const reseeded = findDemoMemory();
  assert.ok(reseeded);
  assert.equal(reseeded.scope, 'USER');
  assert.equal(reseeded.type, 'PREFERENCE');
  assert.equal(reseeded.lifecycle, 'ACTIVE');
  assert.equal(reseeded.sensitivity, 'S1');
  assert.equal(reseeded.userConfirmed, true);
  assert.equal(reseeded.memoryOrigin, 'EXPLICIT_USER');
  assert.equal(reseeded.provenance?.sourceType, 'MANUAL');
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
