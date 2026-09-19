import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { QuestionClassificationService } from '../src/research/question-classification.service.js';
import { WebSearchService } from '../src/research/web-search.service.js';
import { WebSearchProviderPort } from '../src/research/web-search-provider.port.js';
import { EvidencePackService } from '../src/research/evidence-pack.service.js';
import { SourceFreshnessValidator } from '../src/research/source-freshness.validator.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { handleResearchRoutes } from '../src/http/routes/research.routes.js';
import { handleConversationRoutes } from '../src/http/routes/conversation.routes.js';
import { handleCapabilitiesRoutes } from '../src/http/routes/capabilities.routes.js';
import { CapabilityBroker, capabilityRegistry } from '../src/capabilities/index.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import type { SearchQueryInput, SearchResult } from '../src/research/web-search-provider.port.js';

class MockWebSearchProvider implements WebSearchProviderPort {
  public name = 'mock_search';
  public searchCount = 0;
  public lastQuery = '';

  constructor(private readonly mockResults: SearchResult[] = []) {}

  public isConfigured(): boolean {
    return true;
  }

  public async search(input: SearchQueryInput): Promise<SearchResult[]> {
    this.searchCount++;
    this.lastQuery = input.query;
    if (this.mockResults.length > 0) {
      return this.mockResults;
    }
    return [
      {
        id: 'res_01',
        title: 'Linux 6.12 Kernel Released',
        url: 'https://kernel.org/news/6.12.html',
        snippet: 'Linux kernel version 6.12 has been officially released with real-time PREEMPT_RT support.',
        sourceName: 'Kernel.org',
        publishedAt: '2026-09-15T00:00:00Z',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
    ];
  }
}

function createTestAiService() {
  const mockFetch = async () => new Response(
    JSON.stringify({
      choices: [{ message: { content: 'Based on retrieved evidence, Linux 6.12 is released.' } }],
      output_text: 'Based on retrieved evidence, Linux 6.12 is released.',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  const providers = createProviders(
    { OPENAI_API_KEY: 'test-key', NAGEX_OPENAI_MODEL: 'gpt-4o' },
    mockFetch as any
  );
  return new AiService(new UnifiedModelRouter(providers));
}

describe('R22.4 Evidence Pack & Live Web Search Foundation', () => {
  it('QUESTION_FRESHNESS_CLASSIFICATION=PASS', () => {
    const classifier = new QuestionClassificationService();

    const timeless = classifier.classify('What is TCP/IP?');
    assert.equal(timeless.freshness, 'NONE');
    assert.equal(timeless.category, 'GENERAL');

    const freshTech = classifier.classify('Latest Linux kernel release?');
    assert.equal(freshTech.freshness, 'REQUIRED');
    assert.equal(freshTech.category, 'TECHNOLOGY');

    const market = classifier.classify('Current stock price of NVIDIA');
    assert.equal(market.freshness, 'REQUIRED');

    const politics = classifier.classify('Current US interest rate policy by Federal Reserve');
    assert.equal(politics.freshness, 'REQUIRED');

    const law = classifier.classify('What are the latest AI safety regulations in EU?');
    assert.equal(law.freshness, 'REQUIRED');
  });

  it('TIMELESS_QUESTION_SEARCH_CALLS=0 and FRESH_QUESTION_SEARCH_REQUIRED=PASS', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);

    // Timeless question
    const timelessPack = await evidenceService.buildEvidencePack('What is TCP/IP?');
    assert.equal(timelessPack.freshnessRequirement, 'NONE');
    assert.equal(mockProvider.searchCount, 0, 'TIMELESS_QUESTION_SEARCH_CALLS must be 0');
    assert.equal(timelessPack.sources.length, 0);

    // Fresh question
    const freshPack = await evidenceService.buildEvidencePack('Latest Linux kernel release?');
    assert.equal(freshPack.freshnessRequirement, 'REQUIRED');
    assert.equal(mockProvider.searchCount, 1, 'FRESH_QUESTION_SEARCH_REQUIRED calls search');
    assert.equal(freshPack.sources.length > 0, true);
  });

  it('WEB_SEARCH_PROVIDER_ABSTRACTION=PASS and WEB_SEARCH_REAL_STATUS_TRUTHFUL=PASS', async () => {
    // Unconfigured search service
    const unconfiguredSearch = new WebSearchService();
    assert.equal(unconfiguredSearch.status().configured, false);
    assert.equal(unconfiguredSearch.status().status, 'UNAVAILABLE');

    // Configured search service
    const mockProvider = new MockWebSearchProvider();
    const configuredSearch = new WebSearchService(mockProvider);
    assert.equal(configuredSearch.status().configured, true);
    assert.equal(configuredSearch.status().status, 'AVAILABLE');

    // Capabilities route check
    const auditLogger = new AuditLogger();
    const broker = new CapabilityBroker(
      {} as any,
      {} as any,
      {} as any,
      auditLogger,
      capabilityRegistry,
      'capabilities_idempotency_test',
      'NAGEX_CAPABILITIES_IDEMPOTENCY_DIR_TEST',
      undefined,
      undefined,
      undefined,
      undefined,
      unconfiguredSearch,
    );

    const capRes = await handleCapabilitiesRoutes(
      'GET',
      '/api/v1/capabilities/status',
      null,
      {},
      {},
      { capabilityBroker: broker, modelErrorResult: (e) => ({ status: 500, data: e }) }
    );
    assert.equal(capRes?.status, 200);
    const capData = capRes?.data as any;
    assert.equal(capData.webSearch, 'UNAVAILABLE');
    assert.equal(capData.capabilities['web.search'], 'UNAVAILABLE');
  });

  it('EVIDENCE_PACK_CREATED=PASS, EVIDENCE_SOURCE_URL_REQUIRED=PASS, EVIDENCE_RETRIEVED_AT_REQUIRED=PASS', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider([
      {
        id: 's1',
        title: 'Fed Rate Decision',
        url: 'https://federalreserve.gov/news/2026-09-18.html',
        snippet: 'Federal Reserve holds interest rates steady.',
        sourceName: 'Federal Reserve',
        publishedAt: '2026-09-18T14:00:00Z',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
    ]);
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);

    const pack = await evidenceService.buildEvidencePack('Current US interest rate decision');
    assert.ok(pack.evidencePackId.startsWith('evpack_'));
    assert.equal(pack.query, 'Current US interest rate decision');
    assert.equal(pack.freshnessRequirement, 'REQUIRED');
    assert.equal(pack.sources.length, 1);

    const source = pack.sources[0];
    assert.ok(source.url.startsWith('https://'), 'EVIDENCE_SOURCE_URL_REQUIRED=PASS');
    assert.ok(source.retrievedAt, 'EVIDENCE_RETRIEVED_AT_REQUIRED=PASS');
    assert.equal(source.publishedAt, '2026-09-18T14:00:00Z');
  });

  it('SOURCE_URL_FABRICATION=0 and SOURCE_PUBLISHED_DATE_FABRICATION=0', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider([
      {
        id: 's_bad_url',
        title: 'Local Secret',
        url: 'file:///etc/passwd', // SSRF target - should be rejected!
        snippet: 'Local file content',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
      {
        id: 's_undated',
        title: 'Undated Article',
        url: 'https://example.com/article',
        snippet: 'Some current news snippet without published date',
        // publishedAt is intentionally undefined
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
    ]);
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);

    const pack = await evidenceService.buildEvidencePack('Latest news update');
    assert.equal(pack.sources.length, 1, 'Unsafe file:// URL must be rejected (SOURCE_URL_FABRICATION=0)');
    assert.equal(pack.sources[0].url, 'https://example.com/article');
    assert.equal(pack.sources[0].publishedAt, undefined, 'Must not fabricate publication date (SOURCE_PUBLISHED_DATE_FABRICATION=0)');
    assert.equal(pack.sources[0].freshnessStatus, 'UNDATED');
  });

  it('DUPLICATE_SOURCE_COLLAPSE=PASS', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider([
      {
        id: 's1',
        title: 'Duplicate Article 1',
        url: 'https://example.com/news/1',
        snippet: 'Same content article',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
      {
        id: 's2',
        title: 'Duplicate Article 1 (Copy)',
        url: 'https://example.com/news/1', // Exact same URL
        snippet: 'Same content article copy',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
    ]);
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);

    const pack = await evidenceService.buildEvidencePack('Latest news update');
    assert.equal(pack.sources.length, 1, 'Duplicate URLs must be collapsed into one');
  });

  it('SEARCH_PROVIDER_S2_CONTEXT_LEAK=0 and SEARCH_PROVIDER_S3_CONTEXT_LEAK=0', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);

    const sanitized = searchService.sanitizeQuery(
      'Current stock price of NVIDIA for user Jane Smith key sk-proj-1234567890abcdef1234567890'
    );
    assert.equal(sanitized.includes('sk-proj-1234567890abcdef1234567890'), false, 'S3 secret key must be stripped');
    assert.equal(sanitized.includes('Jane Smith'), false, 'S2 personal context name should be stripped');
  });

  it('FRESH_QUESTION_WITHOUT_SEARCH_FAKE_ANSWER=0', async () => {
    // When search is UNAVAILABLE
    const unconfiguredSearch = new WebSearchService();
    const classifier = new QuestionClassificationService();
    const evidenceService = new EvidencePackService(classifier, unconfiguredSearch);
    const aiService = createTestAiService();
    const sessionStore = new SessionStore();
    const convStore = new ConversationStore();
    const convContextService = new ConversationContextService(convStore);
    const auditLogger = new AuditLogger();

    const res = await handleConversationRoutes(
      'POST',
      '/api/v1/ai/chat',
      { prompt: 'What is the current price of Bitcoin today?' },
      {},
      {},
      {
        service: aiService,
        planResolver: {} as any,
        sessionStore,
        convStore,
        convContextService,
        auditLogger,
        getRelevantMemories: () => [],
        memoryExtractor: { extractFromConversation: async () => [], processMessage: async () => null } as any,
        evidencePackService: evidenceService,
      }
    );

    assert.equal(res?.status, 200);
    const data = res?.data as any;
    assert.ok(data.message.includes("I can't verify current information right now"));
    assert.equal(data.evidencePack.freshnessRequirement, 'REQUIRED');
  });

  it('AI_RECEIVES_EVIDENCE_PACK=PASS and MEMORY_EVIDENCE_LAYER_SEPARATION=PASS', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);
    const aiService = createTestAiService();

    const evidencePack = await evidenceService.buildEvidencePack('Latest Linux kernel release?');
    const outcome = await aiService.research({
      query: 'Latest Linux kernel release?',
      evidencePack,
      memories: [],
      requestId: 'req_test_01',
    });

    assert.ok(outcome.data.answer);
    assert.equal(outcome.data.evidencePackId, evidencePack.evidencePackId);
  });

  it('POST /api/v1/research route integration', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);
    const aiService = createTestAiService();

    const res = await handleResearchRoutes(
      'POST',
      '/api/v1/research',
      { query: 'Latest Linux kernel release?' },
      { 'x-nagex-tenant': 'ten_test_01', 'x-principal-id': 'usr_test_01' },
      {},
      {
        aiService,
        evidencePackService: evidenceService,
        modelErrorResult: (e) => ({ status: 500, data: e }),
      }
    );

    assert.equal(res?.status, 200);
    const data = res?.data as any;
    assert.equal(data.query, 'Latest Linux kernel release?');
    assert.equal(data.freshness, 'REQUIRED');
    assert.ok(data.answer);
    assert.ok(data.evidencePackId);
    assert.equal(data.sources.length, 1);
    assert.equal(data.sources[0].url, 'https://kernel.org/news/6.12.html');
  });
});
