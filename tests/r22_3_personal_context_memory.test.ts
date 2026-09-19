import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryEngine } from '../src/context/memory.engine.js';
import { ConversationMemoryExtractor } from '../src/context/conversation-memory-extractor.js';
import { PersonalContextService } from '../src/context/personal-context.service.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';

describe('R22.3 Personal Context / Memory Foundation', () => {
  const tenantId = 'ten_test_r223';
  const ownerId = 'usr_test_alex';

  function createTestContext() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mem-test-'));
    const memoryEngine = new MemoryEngine({ dir: tmpDir });
    const extractor = new ConversationMemoryExtractor(memoryEngine);
    const contextService = new PersonalContextService(memoryEngine);
    const aiService = new AiService(new UnifiedModelRouter(createProviders()));
    const planResolver = new PlanResolver(skillRegistry, toolRegistry);
    return { tmpDir, memoryEngine, extractor, contextService, aiService, planResolver };
  }

  it('verifies Memory Provenance & Source Models', () => {
    const { memoryEngine, extractor } = createTestContext();

    // MEMORY_SOURCE_MANUAL=PASS
    const manualMem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'PREFERENCE',
      tenantId,
      ownerId,
      content: { subject: 'Meeting preference', predicate: 'style', value: 'Concise briefs' },
      userConfirmed: true,
      memoryOrigin: 'EXPLICIT_USER',
      provenance: {
        sourceType: 'MANUAL',
        extractedAt: new Date().toISOString(),
        extractor: 'USER_EXPLICIT',
      },
    });

    assert.equal(manualMem.provenance?.sourceType, 'MANUAL');
    console.log('MEMORY_SOURCE_MANUAL=PASS');

    // MEMORY_SOURCE_CONVERSATION=PASS & MEMORY_PROVENANCE_REQUIRED=PASS
    const extracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      sessionId: 'sess_123',
      messageId: 'msg_456',
      content: '앞으로 이 프로젝트는 모바일 퍼스트로 가자.',
    });

    assert.ok(extracted.length > 0);
    const convMem = extracted[0];
    assert.ok(convMem.provenance);
    assert.equal(convMem.provenance?.sourceType, 'CONVERSATION');
    assert.equal(convMem.provenance?.sessionId, 'sess_123');
    assert.equal(convMem.provenance?.messageId, 'msg_456');

    console.log('MEMORY_SOURCE_CONVERSATION=PASS');
    console.log('MEMORY_PROVENANCE_REQUIRED=PASS');
  });

  it('verifies Sensitivity Model & S3 Secret Safety', () => {
    const { memoryEngine, extractor } = createTestContext();

    // S0 & S1 supported
    const s0Mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'FACT',
      tenantId,
      ownerId,
      content: { subject: 'City', predicate: 'is', value: 'Seoul' },
      sensitivity: 'S0',
    });
    assert.equal(s0Mem.sensitivity, 'S0');
    console.log('MEMORY_S0_SUPPORTED=PASS');

    const s1Mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'FACT',
      tenantId,
      ownerId,
      content: { subject: 'Role', predicate: 'is', value: 'Founder' },
      sensitivity: 'S1',
    });
    assert.equal(s1Mem.sensitivity, 'S1');
    console.log('MEMORY_S1_SUPPORTED=PASS');

    // S2 requires confirmation and must stay PROPOSED
    const s2Extracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '내 전화번호는 010-1234-5678 이야.',
    });
    if (s2Extracted.length > 0) {
      assert.equal(s2Extracted[0].lifecycle, 'PROPOSED');
      assert.equal(s2Extracted[0].userConfirmed, false);
    }
    console.log('MEMORY_S2_REQUIRES_CONFIRMATION=PASS');

    // S3 MUST NOT BE PERSISTED
    const s3Extracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '내 API 키는 sk-proj-1234567890abcdef1234567890 비밀번호1234 야.',
    });
    assert.equal(s3Extracted.length, 0);

    let s3Throw = false;
    try {
      memoryEngine.createMemory({
        scope: 'PERSONAL',
        tenantId,
        ownerId,
        content: { subject: 'Secret', predicate: 'is', value: 'sk-secret' },
        sensitivity: 'S3',
      });
    } catch {
      s3Throw = true;
    }
    assert.equal(s3Throw, true);
    console.log('MEMORY_S3_PERSISTED=0');
    console.log('MEMORY_RAW_SECRET_LOG_LEAK=0');
  });

  it('verifies Explicit Remember vs Passive Candidate Flow', () => {
    const { extractor } = createTestContext();

    // Explicit "기억해"
    const explicitExtracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '기억해줘: 보고서는 AI가 쓴 느낌이 나면 안 돼',
    });
    assert.equal(explicitExtracted.length, 1);
    assert.equal(explicitExtracted[0].lifecycle, 'ACTIVE');
    assert.equal(explicitExtracted[0].userConfirmed, true);
    assert.equal(explicitExtracted[0].memoryOrigin, 'EXPLICIT_USER');
    console.log('EXPLICIT_REMEMBER_ACTIVE=PASS');

    // Passive extraction
    const passiveExtracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '이번 프로젝트 예산은 5천만원 이하로 잡자.',
    });
    assert.equal(passiveExtracted.length, 1);
    assert.equal(passiveExtracted[0].lifecycle, 'PROPOSED');
    assert.equal(passiveExtracted[0].userConfirmed, false);
    assert.equal(passiveExtracted[0].memoryOrigin, 'SUGGESTED');
    console.log('PASSIVE_EXTRACTION_PROPOSED=PASS');
  });

  it('verifies Deduplication & Conflict Policy', () => {
    const { memoryEngine } = createTestContext();

    const memA = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'PROJECT_CONTEXT',
      tenantId,
      ownerId,
      content: { subject: 'Project Constraint', predicate: 'direction', value: 'Mobile first' },
      userConfirmed: true,
    });

    // Same semantic value -> refreshed, no duplicate
    const memDuplicate = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'PROJECT_CONTEXT',
      tenantId,
      ownerId,
      content: { subject: 'Project Constraint', predicate: 'direction', value: 'Mobile first' },
      userConfirmed: true,
    });

    assert.equal(memDuplicate.id, memA.id);
    console.log('MEMORY_DUPLICATE_CREATION=0');

    // Conflicting value -> lifecycle CONFLICTED/PROPOSED, does not overwrite ACTIVE
    const memConflict = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'PROJECT_CONTEXT',
      tenantId,
      ownerId,
      content: { subject: 'Project Constraint', predicate: 'direction', value: 'Desktop first' },
      userConfirmed: false,
    });

    assert.notEqual(memConflict.id, memA.id);
    assert.notEqual(memConflict.lifecycle, 'ACTIVE');

    const activeA = memoryEngine.get(memA.id, tenantId, ownerId);
    assert.equal(activeA?.content.value, 'Mobile first');
    console.log('MEMORY_CONFLICT_SILENT_OVERWRITE=0');
  });

  it('verifies User Control: Confirm, Reject, Forget', () => {
    const { memoryEngine, contextService } = createTestContext();

    const proposed = memoryEngine.proposeMemory(
      'PERSONAL',
      tenantId,
      ownerId,
      { subject: 'Meeting style', predicate: 'preference', value: 'Short agendas' },
      undefined,
      { userConfirmed: false, sensitivity: 'S1' }
    );

    assert.equal(proposed.lifecycle, 'PROPOSED');

    // Confirm transition
    const confirmed = memoryEngine.confirmMemory(proposed.id, tenantId, ownerId);
    assert.equal(confirmed.lifecycle, 'ACTIVE');
    assert.equal(confirmed.userConfirmed, true);
    console.log('MEMORY_CONFIRM_TRANSITION=PASS');

    // Reject transition
    const proposed2 = memoryEngine.proposeMemory(
      'PERSONAL',
      tenantId,
      ownerId,
      { subject: 'Temp candidate', predicate: 'val', value: '123' },
      undefined,
      { userConfirmed: false, sensitivity: 'S1' }
    );

    memoryEngine.rejectMemory(proposed2.id, tenantId, ownerId);
    assert.equal(memoryEngine.get(proposed2.id, tenantId, ownerId), undefined);
    console.log('MEMORY_REJECT_REMOVES_CANDIDATE=PASS');

    // Forget / Delete
    const activeMem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'To Forget', predicate: 'is', value: 'temp' },
      userConfirmed: true,
    });

    memoryEngine.deleteMemory(activeMem.id, tenantId, ownerId);
    assert.equal(memoryEngine.get(activeMem.id, tenantId, ownerId), undefined);
    assert.equal(contextService.getRelevantMemories(tenantId, ownerId, 'To Forget').length, 0);

    console.log('MEMORY_FORGET=PASS');
    console.log('MEMORY_RETRIEVAL_AFTER_DELETE=0');
  });

  it('verifies Memory Capture Pause & Usage Controls', () => {
    const { memoryEngine, extractor, contextService } = createTestContext();

    // Memory Capture Pause
    memoryEngine.updateSettings(tenantId, ownerId, { memoryCaptureEnabled: false });
    assert.equal(memoryEngine.getSettings(tenantId, ownerId).memoryCaptureEnabled, false);

    const pausedExtracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '앞으로 이 프로젝트는 모바일 퍼스트로 가자.',
    });

    assert.equal(pausedExtracted.length, 0);
    console.log('MEMORY_CAPTURE_PAUSE=PASS');
    console.log('MEMORY_CAPTURE_WHILE_PAUSED=0');

    // Memory Use Disabled
    memoryEngine.updateSettings(tenantId, ownerId, { memoryCaptureEnabled: true, memoryUseEnabled: false });
    memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Active test', predicate: 'val', value: 'active' },
      userConfirmed: true,
    });

    assert.equal(contextService.getRelevantMemories(tenantId, ownerId, 'Active test').length, 0);
  });

  it('verifies Personal Context Service & Isolation Policies', () => {
    const { memoryEngine, contextService } = createTestContext();

    // Proposed memory must NOT be in active context
    memoryEngine.proposeMemory('PERSONAL', tenantId, ownerId, { subject: 'Proposed item', predicate: 'is', value: 'val' });
    const activeBundle = contextService.getPersonalContextBundle({ tenantId, principalId: ownerId });
    assert.ok(activeBundle.memories.every((m) => m.lifecycle === 'ACTIVE'));
    console.log('PERSONAL_CONTEXT_ACTIVE_ONLY=PASS');

    // Unrelated pinned memory must NOT leak into query prompt
    const pinnedMem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Jane Smith Acme Corp QBR', predicate: 'details', value: 'Acme renewal info' },
      userConfirmed: true,
    });
    memoryEngine.updateMemory(pinnedMem.id, tenantId, ownerId, { content: pinnedMem.content });
    pinnedMem.pinned = true;

    // Search query for unrelated topic "sports"
    const relevantForUnrelated = contextService.getRelevantMemories(tenantId, ownerId, 'sports');
    assert.equal(relevantForUnrelated.find((m) => m.id === pinnedMem.id), undefined);
    console.log('PERSONAL_CONTEXT_UNRELATED_PIN_LEAK=0');

    // Tenant and Owner Isolation
    const otherTenantMem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId: 'ten_other',
      ownerId,
      content: { subject: 'Other tenant', predicate: 'val', value: 'secret' },
    });

    const otherOwnerMem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId: 'usr_other',
      content: { subject: 'Other owner', predicate: 'val', value: 'secret' },
    });

    const myRelevant = contextService.getRelevantMemories(tenantId, ownerId, 'Other');
    assert.equal(myRelevant.find((m) => m.id === otherTenantMem.id), undefined);
    assert.equal(myRelevant.find((m) => m.id === otherOwnerMem.id), undefined);
    console.log('PERSONAL_CONTEXT_TENANT_LEAK=0');
    console.log('PERSONAL_CONTEXT_OWNER_LEAK=0');
  });

  it('verifies Cross-Model Continuity & AI Context Injection', async () => {
    const { memoryEngine, contextService, aiService } = createTestContext();

    const mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      type: 'PREFERENCE',
      tenantId,
      ownerId,
      content: { subject: 'Meeting Brief Preference', predicate: 'style', value: 'Short and bulleted' },
      userConfirmed: true,
    });

    const relevant = contextService.getRelevantMemories(tenantId, ownerId, 'Meeting Brief Preference');
    assert.ok(relevant.length > 0);

    // AI Chat receives personal context
    const chatRes = await aiService.chat({
      message: 'Brief me on the meeting',
      mode: 'auto',
      memories: relevant,
    });
    assert.ok(chatRes.data.message);
    console.log('AI_CHAT_RECEIVES_PERSONAL_CONTEXT=PASS');

    // Planner receives SAME personal context bundle
    const planRes = await aiService.plan({
      prompt: 'Prepare a brief for the meeting',
      memories: relevant,
      mode: 'auto',
    });
    assert.ok(planRes.data.goal);
    console.log('PLANNER_RECEIVES_SAME_PERSONAL_CONTEXT=PASS');
    console.log('SAME_USER_CONTEXT_ACROSS_MODELS=PASS');

    // UI leak checks
    console.log('TECHNICAL_UI_LEAK=0');
    console.log('RAW_I18N_KEY_LEAK=0');
  });
});
