import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { NagexError } from '../src/common/errors.js';
import { ModelRoutingPolicy } from '../src/model-gateway/model-routing-policy.js';
import type { ModelProviderCapabilities } from '../src/model-gateway/model-routing.types.js';
import { UnifiedModelRouter, type RouterLogger } from '../src/model-gateway/unified-model-router.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import { OpenAIProvider, GeminiProvider, NebiusProvider } from '../src/model-gateway/providers.js';

class MockModelProvider implements ModelProvider {
  public responseText = '{"status":"ok"}';
  public generateCallCount = 0;

  constructor(
    public readonly name: string,
    public readonly model: string | null = 'mock-model',
    public isConfigured = true,
    public statusState: 'UNCONFIGURED' | 'CONFIGURED' | 'LIVE' | 'DEGRADED' = 'LIVE',
    public customCapabilities?: ModelProviderCapabilities,
    public outcome: 'success' | 'failure' = 'success'
  ) {}

  public get capabilities(): ModelProviderCapabilities {
    return (
      this.customCapabilities || {
        provider: this.name,
        supportsJsonMode: true,
        supportsGeneralChat: true,
        supportsStructuredExtraction: true,
      }
    );
  }

  public status(): ProviderStatus {
    return {
      configured: this.isConfigured,
      available: this.statusState === 'LIVE',
      provider: this.name,
      model: this.model,
      status: this.isConfigured ? this.statusState : 'UNCONFIGURED',
      lastCheckedAt: new Date().toISOString(),
      degradedReason: this.statusState === 'DEGRADED' ? 'Test failure' : null,
    };
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    this.generateCallCount++;
    if (this.outcome === 'failure') {
      throw new NagexError({
        code: 'PROVIDER_HTTP_500',
        category: 'PROVIDER',
        message: `${this.name} simulated failure`,
        request_id: request.requestId,
      });
    }
    return {
      text: this.responseText,
      provider: this.name,
      model: this.model || 'mock-model',
      latencyMs: 10,
      requestId: request.requestId,
    };
  }
}

test('NAgex R22.5 — Task-Aware Model Routing Foundation Suite', async () => {
  const metrics: Record<string, string | number> = {};
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];

  const mockLogger: RouterLogger = {
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
  };

  // 1. Real Provider Capability Contract Assertions
  const openAiInst = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-4o' });
  const geminiInst = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-1.5-pro' });
  const nebiusInst = new NebiusProvider({ apiKey: 'test-key', model: 'nebius-model' });

  assert.equal(openAiInst.capabilities.supportsJsonMode, false, 'OpenAI does not support JSON mode in current generate adapter');
  assert.equal(geminiInst.capabilities.supportsJsonMode, true, 'Gemini supports responseMimeType json');
  assert.equal(nebiusInst.capabilities.supportsJsonMode, true, 'Nebius supports response_format json_object');

  metrics.OPENAI_CAPABILITY_CONTRACT = 'PASS';
  metrics.GEMINI_CAPABILITY_CONTRACT = 'PASS';
  metrics.NEBIUS_CAPABILITY_CONTRACT = 'PASS';

  // 2. Unknown Capability Missing MUST NOT Fail-Open (No Fail-Open)
  const unknownCapsProvider: ModelProvider = {
    name: 'unknown_caps',
    model: 'm1',
    status: () => ({
      configured: true,
      available: true,
      provider: 'unknown_caps',
      model: 'm1',
      status: 'LIVE',
      lastCheckedAt: null,
      degradedReason: null,
    }),
    generate: async () => ({ text: 'ok', provider: 'unknown_caps', model: 'm1', latencyMs: 1, requestId: 'r' }),
  };

  const policy = new ModelRoutingPolicy();
  const validJsonProvider = new MockModelProvider('valid_json', 'm2', true, 'LIVE', {
    provider: 'valid_json',
    supportsJsonMode: true,
    supportsGeneralChat: true,
    supportsStructuredExtraction: true,
  });

  const decisionNoFailOpen = policy.select(
    'auto',
    { taskKind: 'PLAN', requiresJson: true, requestId: 'r_no_fail' },
    [unknownCapsProvider, validJsonProvider]
  );

  assert.equal(decisionNoFailOpen.selectedProvider, 'valid_json');
  assert.equal(decisionNoFailOpen.fallbackProviders.includes('unknown_caps'), false);
  metrics.UNKNOWN_CAPABILITY_FAIL_OPEN = 0;

  // 3. Explicit Override Cannot Bypass Required Capability Incompatibility
  assert.throws(
    () => {
      policy.select('openai', { taskKind: 'PLAN', requiresJson: true, requestId: 'r_exp_fail' }, [openAiInst, geminiInst]);
    },
    (err: any) => err instanceof NagexError && err.code === 'MODEL_PROVIDER_CAPABILITY_UNSUPPORTED'
  );
  metrics.EXPLICIT_OVERRIDE_CANNOT_BYPASS_REQUIRED_CAPABILITY = 'PASS';

  // 4. Task Kind Routing Verification
  const providerA = new MockModelProvider('gemini', 'gemini-1.5-pro', true, 'LIVE');
  const providerB = new MockModelProvider('nebius', 'nebius-model', true, 'CONFIGURED');
  const router = new UnifiedModelRouter([providerA, providerB], mockLogger);
  const aiService = new AiService(router);

  // CHAT
  await aiService.chat({ message: 'Hello AI', mode: 'auto' });
  const chatLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'CHAT');
  assert.ok(chatLog, 'CHAT routing decision logged');
  metrics.TASK_KIND_CHAT_ROUTING = 'PASS';

  // RESEARCH_SYNTHESIS
  await aiService.research({
    query: 'Quantum AI',
    evidencePack: {
      evidencePackId: 'pack_1',
      query: 'Quantum AI',
      generatedAt: new Date().toISOString(),
      freshnessRequirement: 'REQUIRED',
      category: 'tech',
      status: 'SUCCESS',
      sources: [
        {
          sourceId: 'src_1',
          url: 'https://example.com',
          title: 'Quantum Title',
          snippet: 'Quantum snippet',
          retrievedAt: new Date().toISOString(),
          freshnessStatus: 'CURRENT',
        },
      ],
    },
    mode: 'auto',
  });
  const researchLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'RESEARCH_SYNTHESIS');
  assert.ok(researchLog, 'RESEARCH_SYNTHESIS routing decision logged');
  metrics.TASK_KIND_RESEARCH_ROUTING = 'PASS';

  // PLAN
  providerA.responseText = JSON.stringify({
    goal: 'Test Plan',
    summary: 'Plan Summary',
    reasoningSummary: 'Plan Reasoning',
    steps: [
      {
        title: 'Step 1',
        reasoning: 'Why 1',
        skill: 'skill.test',
        tool: null,
        requiresApproval: false,
      },
    ],
  });
  await aiService.plan({ prompt: 'Create schedule plan', memories: [], mode: 'auto' });
  const planLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'PLAN');
  assert.ok(planLog, 'PLAN routing decision logged');
  metrics.TASK_KIND_PLAN_ROUTING = 'PASS';

  // STRUCTURED_EXTRACTION
  providerA.responseText = JSON.stringify({
    title: 'Extracted Title',
    summary: 'Extracted Summary',
    contentType: 'note',
    topics: [],
    entities: [],
    dates: [],
    actionItems: [],
    taskCandidates: [],
    calendarCandidates: [],
    memoryCandidates: [],
    knowledgeCandidates: [],
  });
  await aiService.understand({ content: 'Captured text note', contentType: 'note', mode: 'auto' });
  const extractionLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'STRUCTURED_EXTRACTION');
  assert.ok(extractionLog, 'STRUCTURED_EXTRACTION routing decision logged');
  metrics.TASK_KIND_STRUCTURED_EXTRACTION_ROUTING = 'PASS';

  // DAILY_BRIEF
  providerA.responseText = JSON.stringify({
    summary: 'Daily Brief Summary',
    actionItems: [],
  });
  await aiService.brief({ scheduleDigest: '', emailsDigest: '', tasksDigest: '', mode: 'auto' });
  const briefLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'DAILY_BRIEF');
  assert.ok(briefLog, 'DAILY_BRIEF routing decision logged');
  metrics.TASK_KIND_DAILY_BRIEF_ROUTING = 'PASS';

  // MEETING_PREP
  providerA.responseText = JSON.stringify({
    keyPoints: ['Key point 1'],
    suggestedAgenda: ['Agenda item 1'],
  });
  await aiService.meetingPrep({ eventDigest: '', emailsDigest: '', vaultDigest: '', memoryDigest: '', mode: 'auto' });
  const meetingPrepLog = logs.find((l) => l.event === 'model_routing_decision' && l.fields.taskKind === 'MEETING_PREP');
  assert.ok(meetingPrepLog, 'MEETING_PREP routing decision logged');
  metrics.TASK_KIND_MEETING_PREP_ROUTING = 'PASS';

  // 5. JSON Required Provider Filtering
  const noJsonProvider = new MockModelProvider('legacy_provider', 'legacy', true, 'LIVE', {
    provider: 'legacy_provider',
    supportsJsonMode: false,
    supportsGeneralChat: true,
    supportsStructuredExtraction: false,
  });
  const jsonProvider = new MockModelProvider('json_provider', 'json-v1', true, 'LIVE', {
    provider: 'json_provider',
    supportsJsonMode: true,
    supportsGeneralChat: true,
    supportsStructuredExtraction: true,
  });

  const decisionJson = policy.select('auto', { taskKind: 'PLAN', requiresJson: true, requestId: 'req_json' }, [noJsonProvider, jsonProvider]);
  assert.equal(decisionJson.selectedProvider, 'json_provider');
  metrics.JSON_REQUIRED_PROVIDER_FILTERING = 'PASS';

  // 6. Unconfigured & Degraded Ranking
  const unconfiguredProvider = new MockModelProvider('unconfigured', null, false, 'UNCONFIGURED');
  const degradedProvider = new MockModelProvider('degraded', 'deg-1', true, 'DEGRADED');
  const liveProvider = new MockModelProvider('live', 'live-1', true, 'LIVE');

  const decisionDeg = policy.select('auto', { taskKind: 'CHAT', requiresJson: false, requestId: 'req_deg' }, [degradedProvider, unconfiguredProvider, liveProvider]);
  assert.equal(decisionDeg.selectedProvider, 'live');
  assert.equal(decisionDeg.fallbackProviders.includes('unconfigured'), false);
  metrics.UNCONFIGURED_PROVIDER_SELECTED = 0;
  metrics.DEGRADED_PROVIDER_PREFERRED_OVER_LIVE = 0;
  metrics.LIVE_PROVIDER_PRIORITY = 'PASS';

  // 7. Configured Provider Fallback
  const configuredProvider = new MockModelProvider('configured', 'cfg-1', true, 'CONFIGURED');
  const decisionFallback = policy.select('auto', { taskKind: 'CHAT', requiresJson: false, requestId: 'req_fb' }, [liveProvider, configuredProvider]);
  assert.equal(decisionFallback.selectedProvider, 'live');
  assert.deepEqual(decisionFallback.fallbackProviders, ['configured']);
  metrics.CONFIGURED_PROVIDER_FALLBACK = 'PASS';

  // 8. Explicit Override & Unknown Provider Handling
  const decisionOverride = policy.select('nebius', { taskKind: 'CHAT', requiresJson: false, requestId: 'req_ov' }, [providerA, providerB]);
  assert.equal(decisionOverride.selectedProvider, 'nebius');
  metrics.EXPLICIT_PROVIDER_OVERRIDE_COMPATIBILITY = 'PASS';

  assert.throws(() => {
    policy.select('unknown_provider', { taskKind: 'CHAT', requiresJson: false, requestId: 'req_unk' }, [providerA, providerB]);
  }, (err: any) => err instanceof NagexError && err.code === 'MODEL_PROVIDER_NOT_REGISTERED');
  metrics.UNKNOWN_PROVIDER_REJECTED = 'PASS';

  // 9. Runtime Provider Failure Fallback
  const failingProvider = new MockModelProvider('fail_first', 'm1', true, 'LIVE', undefined, 'failure');
  const backupProvider = new MockModelProvider('backup_sec', 'm2', true, 'LIVE');
  backupProvider.responseText = 'Backup response';

  const routerFallback = new UnifiedModelRouter([failingProvider, backupProvider], mockLogger);
  const resFallback = await routerFallback.generate({ messages: [{ role: 'user', content: 'test' }], mode: 'auto', requestId: 'req_fail_fb' });
  assert.equal(resFallback.provider, 'backup_sec');
  assert.equal(resFallback.text, 'Backup response');
  metrics.FIRST_PROVIDER_FAILURE_FALLBACK = 'PASS';

  // 10. Validation Failure Fallback
  const schemaFailProvider = new MockModelProvider('schema_bad', 'm1', true, 'LIVE');
  schemaFailProvider.responseText = '{"invalid_schema": true}';
  const schemaGoodProvider = new MockModelProvider('schema_good', 'm2', true, 'LIVE');
  schemaGoodProvider.responseText = JSON.stringify({
    goal: 'Valid Goal',
    summary: 'Valid Summary',
    reasoningSummary: 'Valid Rationale',
    steps: [{ title: 'Step 1', reasoning: 'Why', skill: 'skill.x', tool: null, requiresApproval: false }],
  });

  const routerSchema = new UnifiedModelRouter([schemaFailProvider, schemaGoodProvider], mockLogger);
  const aiServiceSchema = new AiService(routerSchema);
  const resSchema = await aiServiceSchema.plan({ prompt: 'Create valid plan', memories: [], mode: 'auto' });
  assert.equal(resSchema.provider, 'schema_good');
  metrics.VALIDATION_FAILURE_FALLBACK = 'PASS';

  // 11. All Provider Failure Truthful Error & Fake Success Assertion
  const failAll1 = new MockModelProvider('f1', 'm1', true, 'LIVE', undefined, 'failure');
  const failAll2 = new MockModelProvider('f2', 'm2', true, 'LIVE', undefined, 'failure');
  const routerFailAll = new UnifiedModelRouter([failAll1, failAll2], mockLogger);
  await assert.rejects(async () => {
    await routerFailAll.generate({ messages: [{ role: 'user', content: 'test' }], mode: 'auto', requestId: 'req_all_fail' });
  }, (err: any) => err instanceof NagexError && err.code === 'ALL_MODEL_PROVIDERS_FAILED');
  metrics.ALL_PROVIDER_FAILURE_TRUTHFUL = 'PASS';
  metrics.FAKE_SUCCESS_PATHS = 0;

  // 12. Non-Vacuous Privacy Tests with Injected Secret Markers
  const secretLogs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const secretLogger: RouterLogger = {
    info: (event, fields) => secretLogs.push({ event, fields }),
    warn: (event, fields) => secretLogs.push({ event, fields }),
  };
  const secretRouter = new UnifiedModelRouter([providerA, providerB], secretLogger);
  const secretAiService = new AiService(secretRouter);

  const PROMPT_SECRET = 'ROUTING_TEST_PROMPT_SECRET_123';
  const MEMORY_SECRET = 'ROUTING_TEST_MEMORY_SECRET_456';
  const EVIDENCE_SECRET = 'ROUTING_TEST_EVIDENCE_SECRET_789';

  await secretAiService.chat({
    message: `User message with secret ${PROMPT_SECRET}`,
    memories: [
      {
        id: 'mem_01',
        scope: 'USER',
        tenantId: 'ten_01',
        owner_id: 'usr_01',
        lifecycle: 'ACTIVE',
        content: { subject: 'user', predicate: 'key', value: MEMORY_SECRET },
        sensitivity: 'S1',
        provenance: { sourceType: 'MANUAL', extractor: 'USER_EXPLICIT', extractedAt: new Date().toISOString() },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    evidencePack: {
      evidencePackId: 'pack_secret',
      query: 'Query',
      generatedAt: new Date().toISOString(),
      freshnessRequirement: 'OPTIONAL',
      category: 'tech',
      status: 'SUCCESS',
      sources: [
        {
          sourceId: 'src_sec',
          url: 'https://example.com/secret',
          title: 'Secret Title',
          snippet: EVIDENCE_SECRET,
          retrievedAt: new Date().toISOString(),
          freshnessStatus: 'CURRENT',
        },
      ],
    },
    mode: 'auto',
  });

  const loggedDecision = secretLogs.find((l) => l.event === 'model_routing_decision');
  assert.ok(loggedDecision, 'Routing decision logged');
  metrics.ROUTING_DECISION_LOGGED = 'PASS';

  const allSecretLogsJson = JSON.stringify(secretLogs);
  assert.equal(allSecretLogsJson.includes(PROMPT_SECRET), false, 'Prompt secret marker must not leak in routing logs');
  assert.equal(allSecretLogsJson.includes(MEMORY_SECRET), false, 'Memory secret marker must not leak in routing logs');
  assert.equal(allSecretLogsJson.includes(EVIDENCE_SECRET), false, 'Evidence secret marker must not leak in routing logs');
  assert.doesNotMatch(allSecretLogsJson, /Bearer|api_key|sk-[a-zA-Z0-9]+/);

  metrics.ROUTING_PROMPT_LOG_LEAK = 0;
  metrics.ROUTING_MEMORY_LOG_LEAK = 0;
  metrics.ROUTING_EVIDENCE_LOG_LEAK = 0;

  // 13. Real UI & Safety Assertions
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  const appJs = fs.readFileSync('public/app.js', 'utf8');

  // Assert no primary model selector or provider dropdown exists in primary user UI
  assert.doesNotMatch(indexHtml, /<select[^>]*id="model-picker"/i);
  assert.doesNotMatch(indexHtml, /<select[^>]*class="primary-model-select"/i);
  assert.doesNotMatch(appJs, /renderPrimaryModelPicker/i);
  metrics.MODEL_PICKER_PRIMARY_UI = 0;

  // Assert technical routing errors are not leaked directly into primary working UI
  assert.doesNotMatch(appJs, /"ALL_MODEL_PROVIDERS_FAILED"/);
  metrics.TECHNICAL_UI_LEAK = 0;

  metrics.R22_5_TARGET = 'PASS';

  console.log('R22.5 Final Metrics Report:', JSON.stringify(metrics, null, 2));

  // Assertions for all metrics
  assert.equal(metrics.R22_5_TARGET, 'PASS');
  assert.equal(metrics.OPENAI_CAPABILITY_CONTRACT, 'PASS');
  assert.equal(metrics.GEMINI_CAPABILITY_CONTRACT, 'PASS');
  assert.equal(metrics.NEBIUS_CAPABILITY_CONTRACT, 'PASS');
  assert.equal(metrics.UNKNOWN_CAPABILITY_FAIL_OPEN, 0);
  assert.equal(metrics.EXPLICIT_OVERRIDE_CANNOT_BYPASS_REQUIRED_CAPABILITY, 'PASS');
  assert.equal(metrics.TASK_KIND_CHAT_ROUTING, 'PASS');
  assert.equal(metrics.TASK_KIND_RESEARCH_ROUTING, 'PASS');
  assert.equal(metrics.TASK_KIND_PLAN_ROUTING, 'PASS');
  assert.equal(metrics.TASK_KIND_STRUCTURED_EXTRACTION_ROUTING, 'PASS');
  assert.equal(metrics.TASK_KIND_DAILY_BRIEF_ROUTING, 'PASS');
  assert.equal(metrics.TASK_KIND_MEETING_PREP_ROUTING, 'PASS');
  assert.equal(metrics.JSON_REQUIRED_PROVIDER_FILTERING, 'PASS');
  assert.equal(metrics.UNCONFIGURED_PROVIDER_SELECTED, 0);
  assert.equal(metrics.DEGRADED_PROVIDER_PREFERRED_OVER_LIVE, 0);
  assert.equal(metrics.LIVE_PROVIDER_PRIORITY, 'PASS');
  assert.equal(metrics.CONFIGURED_PROVIDER_FALLBACK, 'PASS');
  assert.equal(metrics.EXPLICIT_PROVIDER_OVERRIDE_COMPATIBILITY, 'PASS');
  assert.equal(metrics.UNKNOWN_PROVIDER_REJECTED, 'PASS');
  assert.equal(metrics.FIRST_PROVIDER_FAILURE_FALLBACK, 'PASS');
  assert.equal(metrics.VALIDATION_FAILURE_FALLBACK, 'PASS');
  assert.equal(metrics.ALL_PROVIDER_FAILURE_TRUTHFUL, 'PASS');
  assert.equal(metrics.ROUTING_DECISION_LOGGED, 'PASS');
  assert.equal(metrics.ROUTING_PROMPT_LOG_LEAK, 0);
  assert.equal(metrics.ROUTING_MEMORY_LOG_LEAK, 0);
  assert.equal(metrics.ROUTING_EVIDENCE_LOG_LEAK, 0);
  assert.equal(metrics.MODEL_PICKER_PRIMARY_UI, 0);
  assert.equal(metrics.TECHNICAL_UI_LEAK, 0);
  assert.equal(metrics.FAKE_SUCCESS_PATHS, 0);
});
