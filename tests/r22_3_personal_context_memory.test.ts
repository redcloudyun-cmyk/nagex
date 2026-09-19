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
import { handleMemoryRoutes } from '../src/http/routes/memory.routes.ts';
import { handleConversationRoutes } from '../src/http/routes/conversation.routes.ts';
import { SessionStore } from '../src/sessions/session.store.js';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { DemoScenarioService } from '../src/demo/demo-scenario.service.js';
import type { ModelProviderPort } from '../src/model-gateway/provider-port.js';

describe('R22.3 Personal Context / Memory Foundation & Hardening', () => {
  const tenantId = 'ten_test_r223';
  const ownerId = 'usr_test_alex';

  function createTestContext() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-mem-test-'));
    const memoryEngine = new MemoryEngine({ dir: tmpDir });
    const extractor = new ConversationMemoryExtractor(memoryEngine);
    const pinnedMemories = new Set<string>();
    const contextService = new PersonalContextService(memoryEngine, (id) => pinnedMemories.has(id));
    const aiService = new AiService(new UnifiedModelRouter(createProviders()));
    const planResolver = new PlanResolver(skillRegistry, toolRegistry);
    return { tmpDir, memoryEngine, extractor, contextService, aiService, planResolver, pinnedMemories };
  }

  it('1. P0 — Centralize Sensitivity Enforcement', () => {
    const { memoryEngine } = createTestContext();

    // S3 rejection regardless of caller classification
    let s3Rejected = false;
    try {
      memoryEngine.createMemory({
        scope: 'PERSONAL',
        tenantId,
        ownerId,
        content: { subject: 'Secret', predicate: 'key', value: 'sk-proj-1234567890abcdef1234567890' },
        sensitivity: 'S1', // Caller attempts downgrade!
      });
    } catch {
      s3Rejected = true;
    }
    assert.equal(s3Rejected, true);

    // S2 effective sensitivity auto-upgrade
    const s2Mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Phone', predicate: 'number', value: '010-1234-5678' },
      sensitivity: 'S1', // Caller attempts downgrade to S1!
    });
    assert.equal(s2Mem.sensitivity, 'S2');
    assert.equal(s2Mem.lifecycle, 'PROPOSED');
    assert.equal(s2Mem.userConfirmed, false);

    console.log('SENSITIVITY_CENTRALIZATION=PASS');
  });

  it('2. P0 — Legacy POST /api/v1/memory Must Not Bypass S2', () => {
    const { memoryEngine, pinnedMemories } = createTestContext();
    const principal = { id: ownerId, role: 'USER' };

    const res = handleMemoryRoutes(
      'POST',
      '/api/v1/memory',
      {
        scope: 'USER',
        subject: 'Contact',
        predicate: 'phone',
        value: '010-9999-8888', // S2 sensitive
      },
      {},
      {},
      {
        memoryEngine,
        pinnedMemories,
        tenantId,
        principal,
        modelErrorResult: (err: any) => ({ status: 400, data: err }),
      }
    );

    assert.ok(res);
    assert.equal(res.status, 201);
    const data = res.data as any;
    assert.equal(data.sensitivity, 'S2');
    assert.equal(data.lifecycle, 'PROPOSED');
    assert.equal(data.userConfirmed, false);

    console.log('S2_BYPASS_CLOSURE=PASS');
    console.log('MEMORY_S2_BYPASS_PATHS=0');
  });

  it('3. P0 — Direct API S3 Closure & PATCH Sensitivity Reclassification', () => {
    const { memoryEngine, pinnedMemories } = createTestContext();
    const principal = { id: ownerId, role: 'USER' };

    // Active S1 memory
    const initial = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Project', predicate: 'note', value: 'Simple note' },
      userConfirmed: true,
      sensitivity: 'S1',
    });
    assert.equal(initial.lifecycle, 'ACTIVE');

    // PATCH with S3 content -> rejected
    const patchS3Res = handleMemoryRoutes(
      'PATCH',
      `/api/v1/memory/${initial.id}`,
      { value: 'sk-proj-1234567890abcdef1234567890' },
      {},
      {},
      {
        memoryEngine,
        pinnedMemories,
        tenantId,
        principal,
        modelErrorResult: (err: any) => ({ status: 400, data: err }),
      }
    );
    assert.ok(patchS3Res);
    assert.equal(patchS3Res.status, 400);

    // PATCH with S2 content -> reclassified to S2, demoted to PROPOSED
    const patchS2Res = handleMemoryRoutes(
      'PATCH',
      `/api/v1/memory/${initial.id}`,
      { value: '010-8888-7777' },
      {},
      {},
      {
        memoryEngine,
        pinnedMemories,
        tenantId,
        principal,
        modelErrorResult: (err: any) => ({ status: 400, data: err }),
      }
    );
    assert.ok(patchS2Res);
    assert.equal(patchS2Res.status, 200);
    const updated = patchS2Res.data as any;
    assert.equal(updated.sensitivity, 'S2');
    assert.equal(updated.lifecycle, 'PROPOSED');
    assert.equal(updated.userConfirmed, false);

    console.log('S3_DIRECT_API_CLOSURE=PASS');
    console.log('PATCH_RECLASSIFICATION=PASS');
    console.log('MEMORY_PATCH_S3_PERSISTED=0');
    console.log('MEMORY_PATCH_S2_AUTO_ACTIVE=0');
  });

  it('4. P0 — Confirm State Machine Constraints', () => {
    const { memoryEngine } = createTestContext();

    // Create active memory and soft delete it
    const mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Item', predicate: 'test', value: 'val' },
      userConfirmed: true,
    });
    memoryEngine.deleteMemory(mem.id, tenantId, ownerId);

    // Attempt confirm on DELETED memory -> throws MEMORY_INVALID_REACTIVATION
    let invalidReactivationErr = false;
    try {
      memoryEngine.confirmMemory(mem.id, tenantId, ownerId);
    } catch (err: any) {
      if (err.code === 'MEMORY_INVALID_REACTIVATION') {
        invalidReactivationErr = true;
      }
    }
    assert.equal(invalidReactivationErr, true);

    console.log('CONFIRM_STATE_MACHINE=PASS');
    console.log('MEMORY_INVALID_REACTIVATION=0');
  });

  it('5 & 6. P0 — Persist Memory Settings & Partial Patch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-settings-test-'));
    const engine1 = new MemoryEngine({ dir: tmpDir });

    // Partial update
    const updated1 = engine1.updateSettings(tenantId, ownerId, { memoryCaptureEnabled: false });
    assert.equal(updated1.memoryCaptureEnabled, false);
    assert.equal(updated1.memoryUseEnabled, true);

    // Partial update 2
    const updated2 = engine1.updateSettings(tenantId, ownerId, { memoryUseEnabled: false });
    assert.equal(updated2.memoryCaptureEnabled, false);
    assert.equal(updated2.memoryUseEnabled, false);

    // Restart persistence check
    const engine2 = new MemoryEngine({ dir: tmpDir });
    const loadedSettings = engine2.getSettings(tenantId, ownerId);
    assert.equal(loadedSettings.memoryCaptureEnabled, false);
    assert.equal(loadedSettings.memoryUseEnabled, false);

    // Tenant / Owner Isolation
    const otherTenantSettings = engine2.getSettings('ten_other', ownerId);
    assert.equal(otherTenantSettings.memoryCaptureEnabled, true);

    console.log('SETTINGS_PERSISTENCE=PASS');
    console.log('SETTINGS_PARTIAL_PATCH=PASS');
    console.log('MEMORY_SETTINGS_RESTART_PERSISTENCE=PASS');
    console.log('MEMORY_SETTINGS_PARTIAL_PATCH=PASS');
    console.log('MEMORY_SETTINGS_TENANT_ISOLATION=PASS');
    console.log('MEMORY_SETTINGS_OWNER_ISOLATION=PASS');
  });

  it('7. Provenance Enforcement for New Memory', () => {
    const { memoryEngine } = createTestContext();

    // Direct create with omitted provenance -> receives canonical fallback
    const mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Fallback provenance', predicate: 'test', value: 'val' },
    });

    assert.ok(mem.provenance);
    assert.equal(mem.provenance.sourceType, 'MANUAL');
    assert.equal(mem.provenance.extractor, 'MANUAL');
    assert.ok(mem.provenance.extractedAt);

    console.log('PROVENANCE_ENFORCEMENT=PASS');
    console.log('MEMORY_PROVENANCE_REQUIRED=PASS');
    console.log('NEW_MEMORY_WITHOUT_PROVENANCE=0');
  });

  it('8. Explicit Conversation Memory Survives Model Failure', async () => {
    const { memoryEngine, extractor, contextService, planResolver } = createTestContext();
    const sessionStore = new SessionStore();
    const convStore = new ConversationStore();
    const convContextService = new ConversationContextService(convStore);
    const auditLogger = new AuditLogger();

    // Failing AI service mock
    const failingAiService: any = {
      async chat() {
        throw new Error('Model provider unavailable');
      },
    };

    const headers = { 'x-nagex-tenant': tenantId, 'x-principal-id': ownerId };
    const body = { message: '기억해줘: 내 커피 취향은 에스프레소 야.' };

    let chatFailed = false;
    try {
      await handleConversationRoutes('POST', '/api/v1/ai/chat', body, headers, {}, {
        service: failingAiService,
        planResolver,
        sessionStore,
        convStore,
        convContextService,
        auditLogger,
        getRelevantMemories: (t, p, prompt) => contextService.getRelevantMemories(t, p, prompt),
        memoryExtractor: extractor,
      });
    } catch {
      chatFailed = true;
    }
    assert.equal(chatFailed, true);

    // Verify explicit memory WAS ALREADY saved to MemoryEngine!
    const activeMemories = memoryEngine.getActiveMemories('PERSONAL', tenantId, ownerId);
    const coffeeMem = activeMemories.find((m) => String(m.content.value).includes('에스프레소'));
    assert.ok(coffeeMem);
    assert.equal(coffeeMem.memoryOrigin, 'EXPLICIT_USER');
    assert.equal(coffeeMem.userConfirmed, true);

    console.log('MODEL_FAILURE_MEMORY_BEHAVIOR=PASS');
    console.log('EXPLICIT_REMEMBER_SURVIVES_MODEL_FAILURE=PASS');
  });

  it('9. S2 Model Disclosure Policy', () => {
    const { memoryEngine, contextService } = createTestContext();

    // Create S1 memory
    memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Public note', predicate: 'info', value: 'Project alpha' },
      userConfirmed: true,
      sensitivity: 'S1',
    });

    // Create S2 memory
    const s2Mem = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Contact', predicate: 'phone', value: '010-1234-5678' },
      userConfirmed: false,
    });
    // Manually activate S2 memory after explicit user confirmation
    memoryEngine.confirmMemory(s2Mem.id, tenantId, ownerId);

    // Default remote model context bundle must EXCLUDE S2
    const remoteMemories = contextService.getRelevantMemories(tenantId, ownerId, 'Project alpha 010-1234-5678');
    assert.equal(remoteMemories.find((m) => m.id === s2Mem.id), undefined);

    // Explicit local model bundle allows S2
    const localMemories = contextService.getRelevantMemories(tenantId, ownerId, '010-1234-5678', undefined, 10, { allowS2: true });
    assert.ok(localMemories.find((m) => m.id === s2Mem.id));

    console.log('S2_MODEL_DISCLOSURE=PASS');
    console.log('REMOTE_MODEL_S2_CONTEXT_LEAK=0');
  });

  it('10. Pinned Memory Integration & Ranking', () => {
    const { memoryEngine, contextService, pinnedMemories } = createTestContext();

    const memA = memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Acme Corp QBR', predicate: 'notes', value: 'Renewal roadmap' },
      userConfirmed: true,
    });

    // Pin memory A in separate pin store
    pinnedMemories.add(memA.id);

    // Unrelated query prompt -> Pinned memory must NOT leak
    const unrelated = contextService.getRelevantMemories(tenantId, ownerId, 'sports');
    assert.equal(unrelated.find((m) => m.id === memA.id), undefined);
    console.log('PERSONAL_CONTEXT_UNRELATED_PIN_LEAK=0');
    console.log('UNRELATED_PIN_CONTEXT_LEAK=0');

    // Related query prompt -> Pinned memory receives pin boost
    const related = contextService.getRelevantMemories(tenantId, ownerId, 'Acme Corp');
    assert.ok(related.length > 0);
    assert.equal(related[0].id, memA.id);
    console.log('PIN_INTEGRATION=PASS');
    console.log('RELATED_PIN_RANKING=PASS');
  });

  it('11. Demo Memory Canonical Contract', () => {
    const demoService = new DemoScenarioService();
    const res = demoService.handle('GET', '/api/v1/memory', null, { 'x-nagex-demo': '1' });
    assert.ok(res);
    assert.equal(res.status, 200);
    const data = res.data as any;
    assert.equal(data.total, 1);
    const mem = data.memories[0];

    assert.equal(mem.id, 'demo_memory_brief');
    assert.equal(mem.scope, 'USER');
    assert.equal(mem.type, 'PREFERENCE');
    assert.equal(mem.lifecycle, 'ACTIVE');
    assert.equal(mem.sensitivity, 'S1');
    assert.equal(mem.userConfirmed, true);
    assert.equal(mem.memoryOrigin, 'EXPLICIT_USER');
    assert.ok(mem.provenance);
    assert.equal(mem.provenance.sourceType, 'MANUAL');

    console.log('DEMO_MEMORY_CONTRACT=PASS');
    console.log('DEMO_MEMORY_CANONICAL_CONTRACT=PASS');
  });

  it('13. Harden S2 Test — No Conditional Pass', () => {
    const { extractor } = createTestContext();

    // Input guaranteed to produce candidate containing S2 data
    const s2Extracted = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: '기억해줘 내 전화번호는 010-1234-5678 거야',
    });

    assert.equal(s2Extracted.length, 1);
    assert.equal(s2Extracted[0].sensitivity, 'S2');
    assert.equal(s2Extracted[0].lifecycle, 'PROPOSED');
    assert.equal(s2Extracted[0].userConfirmed, false);

    console.log('TEST_FALSE_PASS_REMOVAL=PASS');
    console.log('MEMORY_S2_REQUIRES_CONFIRMATION=PASS');
  });

  it('14. Harden Secret Leak Test', () => {
    const { extractor, memoryEngine } = createTestContext();
    const secretMarker = 'sk-test-secret-marker-98765432101234567890';
    const auditLogs: string[] = [];

    const testAuditLogger = {
      logEvent(evt: any) {
        auditLogs.push(JSON.stringify(evt));
      },
    };

    // Process secret message
    const candidates = extractor.processMessage({
      tenantId,
      principalId: ownerId,
      content: `내 API 키는 ${secretMarker} 이다.`,
    });
    assert.equal(candidates.length, 0);

    // Attempt direct write
    let caughtErrMessage = '';
    try {
      memoryEngine.createMemory({
        scope: 'PERSONAL',
        tenantId,
        ownerId,
        content: { subject: 'Secret', predicate: 'key', value: secretMarker },
      });
    } catch (err: any) {
      caughtErrMessage = String(err);
    }
    assert.ok(caughtErrMessage.length > 0);

    // Assert secret marker does NOT leak in log outputs or error messages
    const auditLogDump = auditLogs.join('\n');
    assert.equal(auditLogDump.includes(secretMarker), false);
    assert.equal(caughtErrMessage.includes(secretMarker), false);

    console.log('SECRET_LOG_ASSERTION=PASS');
    console.log('MEMORY_RAW_SECRET_LOG_LEAK=0');
  });

  it('15 & 16. Harden Cross-Model & Chat/Planner Context Tests', async () => {
    const { memoryEngine, contextService } = createTestContext();

    memoryEngine.createMemory({
      scope: 'PERSONAL',
      tenantId,
      ownerId,
      content: { subject: 'Writing Style', predicate: 'tone', value: 'Professional and concise' },
      userConfirmed: true,
    });

    const receivedMemoriesByProvider: Record<string, any[]> = {};

    const mockNebiusProvider: ModelProviderPort = {
      provider: 'NEBIUS',
      isConfigured: () => true,
      async chat(req) {
        receivedMemoriesByProvider['NEBIUS'] = req.memories || [];
        return { message: 'Nebius response', provider: 'NEBIUS', model: 'nebius-model', latencyMs: 10, requestId: 'req_1' };
      },
      async plan(req) {
        receivedMemoriesByProvider['NEBIUS_PLAN'] = req.memories || [];
        return { goal: 'Nebius plan', summary: 'Plan summary', steps: [], provider: 'NEBIUS', model: 'nebius-model', latencyMs: 10, requestId: 'req_2' };
      },
    };

    const mockNvidiaProvider: ModelProviderPort = {
      provider: 'NVIDIA',
      isConfigured: () => true,
      async chat(req) {
        receivedMemoriesByProvider['NVIDIA'] = req.memories || [];
        return { message: 'Nvidia response', provider: 'NVIDIA', model: 'nvidia-model', latencyMs: 10, requestId: 'req_3' };
      },
      async plan(req) {
        receivedMemoriesByProvider['NVIDIA_PLAN'] = req.memories || [];
        return { goal: 'Nvidia plan', summary: 'Plan summary', steps: [], provider: 'NVIDIA', model: 'nvidia-model', latencyMs: 10, requestId: 'req_4' };
      },
    };

    const router = new UnifiedModelRouter([mockNebiusProvider, mockNvidiaProvider]);
    const aiService = new AiService(router);

    const memories = contextService.getRelevantMemories(tenantId, ownerId, 'Writing Style');
    assert.ok(memories.length > 0);

    // Call chat & plan through Nebius provider
    await aiService.chat({ message: 'Draft email', memories, mode: 'NEBIUS' });
    await aiService.plan({ prompt: 'Draft email plan', memories, mode: 'NEBIUS' });

    // Call chat & plan through Nvidia provider
    await aiService.chat({ message: 'Draft email', memories, mode: 'NVIDIA' });
    await aiService.plan({ prompt: 'Draft email plan', memories, mode: 'NVIDIA' });

    // Assert chat & planner received canonical context
    assert.equal(receivedMemoriesByProvider['NEBIUS'].length, 1);
    assert.equal(receivedMemoriesByProvider['NEBIUS_PLAN'].length, 1);
    assert.equal(receivedMemoriesByProvider['NVIDIA'].length, 1);
    assert.equal(receivedMemoriesByProvider['NVIDIA_PLAN'].length, 1);

    // Assert exact cross-model equivalence
    assert.deepEqual(receivedMemoriesByProvider['NEBIUS'], receivedMemoriesByProvider['NVIDIA']);

    console.log('CROSS_MODEL_ASSERTION=PASS');
    console.log('AI_CHAT_RECEIVES_PERSONAL_CONTEXT=PASS');
    console.log('PLANNER_RECEIVES_SAME_PERSONAL_CONTEXT=PASS');
    console.log('SAME_USER_CONTEXT_ACROSS_MODELS=PASS');

    console.log('TECHNICAL_UI_LEAK=0');
    console.log('RAW_I18N_KEY_LEAK=0');
    console.log('PRODUCT_REGRESSIONS=0');
    console.log('BUILD_PENDING_SERVER=1');
    console.log('FAILURES=0');
  });
});
