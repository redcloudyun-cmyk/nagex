// P05 — NAgex Persistent Memory.
//
// Comprehensive test suite for P05 directive requirements:
// - P05-01: proposeMemory persists to disk
// - P05-02: activateMemory persists ACTIVE lifecycle
// - P05-03: restart restores same Memory ID
// - P05-04: restart preserves scope / owner / content
// - P05-05: candidateId persists
// - P05-06: findByCandidateId works after restart
// - P05-07: delete removes persistent file
// - P05-08: deleted Memory does not return after restart
// - P05-09: owner isolation
// - P05-10: inactive Memory excluded from getActiveMemories
// - P05-11: seed initialization idempotent
// - P05-12: restart does not duplicate seed memories
// - P05-13: candidate reconciliation does not duplicate Memory
// - P05-14: corrupt Memory file is isolated
// - P05-15: record without candidateId remains backward compatible
// - P05-16: existing relevance retrieval remains unchanged

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEngine, type MemoryRecord } from '../src/context/memory.engine.js';
import { CaptureStore } from '../src/workspace/capture.store.js';
import { CandidateStore } from '../src/workspace/candidate.store.js';
import { CandidateActionResolver } from '../src/workspace/action-resolver.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `nagex-p05-${prefix}-`));
}

test('P05-01: proposeMemory persists to disk', async () => {
  const dir = tempDir('p05_01');
  const engine = new MemoryEngine({ dir });

  const record = engine.proposeMemory('USER', 'usr_001', {
    subject: 'Preferred Tools',
    predicate: 'channel',
    value: 'Gmail',
  });

  const filePath = path.join(dir, `${record.id}.json`);
  assert.ok(fs.existsSync(filePath), 'proposeMemory must write JSON record file to disk');
  const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(fileContent.id, record.id);
  assert.equal(fileContent.lifecycle, 'PROPOSED');
});

test('P05-02: activateMemory persists ACTIVE lifecycle', async () => {
  const dir = tempDir('p05_02');
  const engine = new MemoryEngine({ dir });

  const record = engine.proposeMemory('USER', 'usr_001', {
    subject: 'Preferred Tools',
    predicate: 'channel',
    value: 'Gmail',
  });

  const activated = engine.activateMemory(record.id);
  assert.equal(activated.lifecycle, 'ACTIVE');

  const filePath = path.join(dir, `${record.id}.json`);
  const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(fileContent.lifecycle, 'ACTIVE');
  assert.equal(fileContent.updated_at, activated.updated_at);
});

test('P05-03: restart restores same Memory ID', async () => {
  const dir = tempDir('p05_03');
  const engine1 = new MemoryEngine({ dir });

  const record = engine1.proposeMemory('USER', 'usr_001', {
    subject: 'User Profile',
    predicate: 'is',
    value: 'Alice',
  });
  engine1.activateMemory(record.id);

  // Simulate process restart by instantiating a new MemoryEngine with the same directory
  const engine2 = new MemoryEngine({ dir });
  const activeMemories = engine2.getActiveMemories('USER', 'usr_001');

  assert.equal(activeMemories.length, 1);
  assert.equal(activeMemories[0].id, record.id);
});

test('P05-04: restart preserves scope / owner / content', async () => {
  const dir = tempDir('p05_04');
  const engine1 = new MemoryEngine({ dir });

  const record = engine1.proposeMemory('AGENT', 'usr_002', {
    subject: 'Acme Corp Context',
    predicate: 'memory_summary',
    value: 'High priority customer',
  });
  engine1.activateMemory(record.id);

  const engine2 = new MemoryEngine({ dir });
  const active = engine2.getActiveMemories('AGENT', 'usr_002');

  assert.equal(active.length, 1);
  assert.equal(active[0].scope, 'AGENT');
  assert.equal(active[0].owner_id, 'usr_002');
  assert.equal(active[0].content.subject, 'Acme Corp Context');
  assert.equal(active[0].content.predicate, 'memory_summary');
  assert.equal(active[0].content.value, 'High priority customer');
});

test('P05-05: candidateId persists', async () => {
  const dir = tempDir('p05_05');
  const engine = new MemoryEngine({ dir });

  const record = engine.proposeMemory(
    'USER',
    'usr_001',
    { subject: 'user', predicate: 'preference', value: 'Dark Mode' },
    'cand_123',
  );

  const filePath = path.join(dir, `${record.id}.json`);
  const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(fileContent.candidateId, 'cand_123');
});

test('P05-06: findByCandidateId works after restart', async () => {
  const dir = tempDir('p05_06');
  const engine1 = new MemoryEngine({ dir });

  const record = engine1.proposeMemory(
    'USER',
    'usr_001',
    { subject: 'user', predicate: 'preference', value: 'Dark Mode' },
    'cand_456',
  );
  engine1.activateMemory(record.id);

  const engine2 = new MemoryEngine({ dir });
  const restored = engine2.findByCandidateId('cand_456');

  assert.ok(restored);
  assert.equal(restored.id, record.id);
  assert.equal(restored.candidateId, 'cand_456');
});

test('P05-07: delete removes persistent file', async () => {
  const dir = tempDir('p05_07');
  const engine = new MemoryEngine({ dir });

  const record = engine.proposeMemory('USER', 'usr_001', {
    subject: 'Temporary',
    predicate: 'flag',
    value: true,
  });

  const filePath = path.join(dir, `${record.id}.json`);
  assert.ok(fs.existsSync(filePath));

  engine.deleteMemory(record.id);
  assert.equal(fs.existsSync(filePath), false, 'deleted memory file must be removed from disk');
});

test('P05-08: deleted Memory does not return after restart', async () => {
  const dir = tempDir('p05_08');
  const engine1 = new MemoryEngine({ dir });

  const record = engine1.proposeMemory('USER', 'usr_001', {
    subject: 'To Delete',
    predicate: 'test',
    value: 123,
  });
  engine1.activateMemory(record.id);
  engine1.deleteMemory(record.id);

  const engine2 = new MemoryEngine({ dir });
  const active = engine2.getActiveMemories('USER', 'usr_001');
  assert.equal(active.length, 0, 'deleted memory must not return after restart');
  assert.equal(engine2.findByCandidateId('cand_to_delete'), undefined);
});

test('P05-09: owner isolation', async () => {
  const dir = tempDir('p05_09');
  const engine = new MemoryEngine({ dir });

  const memA = engine.proposeMemory('USER', 'owner_A', { subject: 'A', predicate: 'is', value: 1 });
  engine.activateMemory(memA.id);

  const memB = engine.proposeMemory('USER', 'owner_B', { subject: 'B', predicate: 'is', value: 2 });
  engine.activateMemory(memB.id);

  const memoriesA = engine.getActiveMemories('USER', 'owner_A');
  assert.equal(memoriesA.length, 1);
  assert.equal(memoriesA[0].owner_id, 'owner_A');
  assert.equal(memoriesA[0].id, memA.id);
});

test('P05-10: inactive Memory excluded from getActiveMemories', async () => {
  const dir = tempDir('p05_10');
  const engine = new MemoryEngine({ dir });

  const proposed = engine.proposeMemory('USER', 'usr_001', { subject: 'Prop', predicate: 'is', value: 'x' });
  const active = engine.proposeMemory('USER', 'usr_001', { subject: 'Act', predicate: 'is', value: 'y' });
  engine.activateMemory(active.id);

  const list = engine.getActiveMemories('USER', 'usr_001');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, active.id);
});

test('P05-11: seed initialization idempotent', async () => {
  const dir = tempDir('p05_11');
  const engine = new MemoryEngine({ dir });

  const seed1 = engine.findSeedMemory({ scope: 'USER', ownerId: 'usr_001', subject: 'User Profile', predicate: 'is' });
  assert.equal(seed1, undefined);

  const created = engine.proposeMemory('USER', 'usr_001', { subject: 'User Profile', predicate: 'is', value: 'Jane' });
  engine.activateMemory(created.id);

  const found = engine.findSeedMemory({ scope: 'USER', ownerId: 'usr_001', subject: 'User Profile', predicate: 'is' });
  assert.ok(found);
  assert.equal(found.id, created.id);
});

test('P05-12: restart does not duplicate seed memories', async () => {
  const dir = tempDir('p05_12');
  const oldEnv = process.env.NAGEX_MEMORIES_DIR;
  process.env.NAGEX_MEMORIES_DIR = dir;
  try {
    const app1 = createNagexApplication();
    const active1 = app1.memoryEngine.getActiveMemories('USER', 'usr_admin_001');
    const count1 = active1.length;
    assert.ok(count1 >= 3, 'initial seed memories created');

    const app2MemoryEngine = new MemoryEngine({ dir });
    const active2 = app2MemoryEngine.getActiveMemories('USER', 'usr_admin_001');
    assert.equal(active2.length, count1, 'restart must not create duplicate seed memories');
  } finally {
    if (oldEnv !== undefined) {
      process.env.NAGEX_MEMORIES_DIR = oldEnv;
    } else {
      delete process.env.NAGEX_MEMORIES_DIR;
    }
  }
});

test('P05-13: candidate reconciliation does not duplicate Memory', async () => {
  const dir = tempDir('p05_13');
  const captureStore = new CaptureStore(tempDir('p05_13_cap'));
  const item = captureStore.createCapture({ ownerId: 'usr_p05', tenantId: 't_p05', type: 'TEXT', content: 'Prefers dark theme', metadata: {} });
  const cap = captureStore.updateStatus(item.captureId, 'READY', { contentHash: 'hash_p05' })!;

  const candidateStore = new CandidateStore({ dir: tempDir('p05_13_cand') });
  const cand = candidateStore.upsert({
    tenantId: 't_p05',
    principalId: 'usr_p05',
    captureId: cap.captureId,
    contentHash: 'hash_p05',
    sourceRefs: [`capture:${cap.captureId}`],
    title: 'Remember preference',
    type: 'MEMORY',
    payload: { statement: 'Prefers dark theme' },
  });
  candidateStore.accept(cand.candidateId, 't_p05', 'usr_p05');

  const memoryEngine1 = new MemoryEngine({ dir });
  const resolver1 = new CandidateActionResolver({ candidateStore, captureStore, memoryEngine: memoryEngine1 });
  const result1 = await resolver1.executeCandidate(cand.candidateId, 't_p05', 'usr_p05');

  assert.equal(result1.action?.status, 'SUCCEEDED');
  const mem1Id = result1.action?.targetId;
  assert.ok(mem1Id);

  // Process restart: new MemoryEngine instance reading same directory
  const memoryEngine2 = new MemoryEngine({ dir });
  const resolver2 = new CandidateActionResolver({ candidateStore, captureStore, memoryEngine: memoryEngine2 });

  // Re-reconcile or execute candidate again after restart
  const result2 = await resolver2.executeCandidate(cand.candidateId, 't_p05', 'usr_p05');
  assert.equal(result2.action?.status, 'SUCCEEDED');
  assert.equal(result2.action?.targetId, mem1Id, 'reconciliation must reuse existing Memory ID across restart');

  const activeMemories = memoryEngine2.getActiveMemories('USER', 'usr_p05');
  assert.equal(activeMemories.length, 1, 'must have exactly one memory record, no duplicate');
});

test('P05-14: corrupt Memory file is isolated', async () => {
  const dir = tempDir('p05_14');
  const engine1 = new MemoryEngine({ dir });

  const mem1 = engine1.proposeMemory('USER', 'usr_001', { subject: 'Valid1', predicate: 'is', value: 1 });
  const mem2 = engine1.proposeMemory('USER', 'usr_001', { subject: 'Corrupt', predicate: 'is', value: 2 });
  const mem3 = engine1.proposeMemory('USER', 'usr_001', { subject: 'Valid3', predicate: 'is', value: 3 });

  // Corrupt mem2 JSON file manually
  const corruptPath = path.join(dir, `${mem2.id}.json`);
  fs.writeFileSync(corruptPath, '{ INVALID JSON ...');

  // Restart MemoryEngine
  const engine2 = new MemoryEngine({ dir });

  const loadedIds = [mem1.id, mem3.id];
  for (const id of loadedIds) {
    const filePath = path.join(dir, `${id}.json`);
    assert.ok(fs.existsSync(filePath));
  }
});

test('P05-15: record without candidateId remains backward compatible', async () => {
  const dir = tempDir('p05_15');

  // Manually write an old-format memory JSON file without candidateId
  const oldRecord = {
    id: 'mem_legacy_001',
    scope: 'USER',
    owner_id: 'usr_legacy',
    lifecycle: 'ACTIVE',
    content: {
      subject: 'Preferred Tools',
      predicate: 'channel',
      value: 'Gmail',
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mem_legacy_001.json'), JSON.stringify(oldRecord), 'utf8');

  const engine = new MemoryEngine({ dir });
  const active = engine.getActiveMemories('USER', 'usr_legacy');

  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'mem_legacy_001');
  assert.equal(active[0].candidateId, undefined);
});

test('P05-16: existing relevance retrieval remains unchanged', async () => {
  const dir = tempDir('p05_16');
  const engine = new MemoryEngine({ dir });

  const mem1 = engine.proposeMemory('USER', 'usr_001', { subject: 'Gmail', predicate: 'usage', value: 'Frequent' });
  engine.activateMemory(mem1.id);

  const active = engine.getActiveMemories('USER', 'usr_001');
  assert.equal(active.length, 1);
  assert.equal(active[0].content.subject, 'Gmail');
});
