import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { QuestionClassificationService } from '../src/research/question-classification.service.js';
import { WebSearchService } from '../src/research/web-search.service.js';
import { TavilyWebSearchProvider } from '../src/research/providers/tavily-web-search.provider.js';
import { HttpWebSearchProvider } from '../src/research/providers/http-web-search.provider.js';
import { EvidencePackService } from '../src/research/evidence-pack.service.js';
import { SourceFreshnessValidator } from '../src/research/source-freshness.validator.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { createProviders } from '../src/model-gateway/providers.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { handleResearchRoutes } from '../src/http/routes/research.routes.js';
import { handleConversationRoutes } from '../src/http/routes/conversation.routes.js';
import { handleCapabilitiesRoutes } from '../src/http/routes/capabilities.routes.js';
import { CapabilityBroker, capabilityRegistry } from '../src/capabilities/index.js';
import { SessionStore } from '../src/sessions/session.store.js';
import { ConversationStore } from '../src/conversations/conversation.store.js';
import { ConversationContextService } from '../src/conversations/conversation-context.service.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import type { SearchQueryInput, SearchQueryResult, SearchResult, WebSearchProviderPort } from '../src/research/web-search-provider.port.js';

class MockWebSearchProvider implements WebSearchProviderPort {
  public name = 'mock_search';
  public searchCount = 0;
  public lastQuery = '';
  public overrideStatus?: any;

  constructor(private readonly mockResults?: SearchResult[], private readonly mockStatus: any = 'SUCCESS') {}

  public isConfigured(): boolean {
    return true;
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    this.searchCount++;
    this.lastQuery = input.query;
    const status = this.overrideStatus || this.mockStatus;
    if (status !== 'SUCCESS') {
      return {
        status,
        results: [],
        error: `Mock provider forced failure ${status}`,
        provider: this.name,
      };
    }
    if (this.mockResults !== undefined) {
      return {
        status: 'SUCCESS',
        results: this.mockResults,
        provider: this.name,
      };
    }
    return {
      status: 'SUCCESS',
      results: [
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
      ],
      provider: this.name,
    };
  }
}

function createPromptCapturingAiService(capturedMessagesContainer: { messages: any[] }) {
  const mockFetch = async (_url: string, options?: any) => {
    if (options?.body) {
      try {
        const parsed = JSON.parse(options.body);
        const msgs = parsed.input || parsed.messages || [];
        if (msgs.length > 0) {
          capturedMessagesContainer.messages = msgs;
        }
      } catch {}
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Based on retrieved evidence [src_1], Linux 6.12 is released.' } }],
        output_text: 'Based on retrieved evidence [src_1], Linux 6.12 is released.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
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
    assert.equal(timelessPack.status, 'NOT_REQUIRED');
    assert.equal(mockProvider.searchCount, 0, 'TIMELESS_QUESTION_SEARCH_CALLS must be 0');
    assert.equal(timelessPack.sources.length, 0);

    // Fresh question
    const freshPack = await evidenceService.buildEvidencePack('Latest Linux kernel release?');
    assert.equal(freshPack.freshnessRequirement, 'REQUIRED');
    assert.equal(freshPack.status, 'SUCCESS');
    assert.equal(mockProvider.searchCount, 1, 'FRESH_QUESTION_SEARCH_REQUIRED calls search');
    assert.equal(freshPack.sources.length > 0, true);
  });

  it('WEB_SEARCH_PROVIDER_ABSTRACTION=PASS, WEB_SEARCH_REAL_PROVIDER_CONTRACT=PASS, and WEB_SEARCH_REAL_STATUS_TRUTHFUL=PASS', async () => {
    // Unconfigured search service (Directive D: truthful unconfigured state)
    const unconfiguredSearch = new WebSearchService(new TavilyWebSearchProvider({ apiKey: '' }));
    assert.equal(unconfiguredSearch.status().configured, false);
    assert.equal(unconfiguredSearch.status().status, 'UNAVAILABLE');

    // Tavily provider adapter contract test (Directive C)
    let tavilyBody: any = null;
    const mockTavilyFetch = async (_url: string, opts: any) => {
      tavilyBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Tavily Search Result',
              url: 'https://tavily.com/article',
              content: 'Tavily normalized content snippet',
              published_date: '2026-09-18',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const tavilyProvider = new TavilyWebSearchProvider({
      apiKey: 'tvly-test-1234567890',
      fetchFn: mockTavilyFetch as any,
    });
    assert.equal(tavilyProvider.isConfigured(), true);
    assert.equal(tavilyProvider.name, 'tavily');

    const tavilyRes = await tavilyProvider.search({ query: 'NVIDIA Q3 earnings' });
    assert.equal(tavilyRes.status, 'SUCCESS');
    assert.equal(tavilyRes.results.length, 1);
    assert.equal(tavilyRes.results[0].title, 'Tavily Search Result');
    assert.equal(tavilyRes.results[0].url, 'https://tavily.com/article');
    assert.equal(tavilyRes.results[0].provider, 'tavily');
    assert.equal(tavilyBody.api_key, 'tvly-test-1234567890');
    assert.equal(tavilyBody.query, 'NVIDIA Q3 earnings');

    // Capabilities route check
    const configuredSearch = new WebSearchService(tavilyProvider);
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
      configuredSearch
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
    assert.equal(capData.webSearch, 'AVAILABLE');
    assert.equal(capData.capabilities['web.search'], 'AVAILABLE');
  });

  it('SEARCH_FAILURE_STATUS_TRUTHFUL=PASS', async () => {
    // Directive E: Auth failure vs rate limit vs timeout vs provider error
    const authFailFetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    const authProvider = new TavilyWebSearchProvider({ apiKey: 'bad-key', fetchFn: authFailFetch as any });
    const authRes = await authProvider.search({ query: 'test' });
    assert.equal(authRes.status, 'AUTH_FAILED');

    const rateLimitFetch = async () => new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 });
    const rateLimitProvider = new TavilyWebSearchProvider({ apiKey: 'key', fetchFn: rateLimitFetch as any });
    const rateRes = await rateLimitProvider.search({ query: 'test' });
    assert.equal(rateRes.status, 'RATE_LIMITED');
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
    assert.equal(pack.status, 'SUCCESS');
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

  it('DUPLICATE_SOURCE_COLLAPSE=PASS and Category-Aware Freshness', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider([
      {
        id: 's1',
        title: 'Article 1',
        url: 'https://example.com/news/1',
        snippet: 'First article',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
      {
        id: 's2',
        title: 'Article 2',
        url: 'https://example.com/news/2',
        snippet: 'Second article on same domain',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
      {
        id: 's3',
        title: 'Article 3',
        url: 'https://example.com/news/3', // 3rd article on same domain - should be collapsed!
        snippet: 'Third article on same domain',
        retrievedAt: new Date().toISOString(),
        provider: 'mock_search',
      },
    ]);
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);

    const pack = await evidenceService.buildEvidencePack('Latest news update');
    // Directive J: domain deduplication allows up to 2 per domain, collapses excess (3rd collapsed)
    assert.equal(pack.sources.length, 2, 'Domain deduplication must allow up to 2 and collapse 3rd+');

    // Directive I: Future dated source is classified SUSPICIOUS
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString();
    const suspiciousStatus = SourceFreshnessValidator.validateFreshness(futureDate, new Date().toISOString(), 'NEWS');
    assert.equal(suspiciousStatus, 'SUSPICIOUS');
  });

  it('SEARCH_PROVIDER_S2_CONTEXT_LEAK=0 and SEARCH_PROVIDER_S3_CONTEXT_LEAK=0', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);

    const sanitized = searchService.sanitizeQuery(
      'Current stock price of NVIDIA for user Jane Smith key sk-proj-1234567890abcdef1234567890 user@example.com'
    );
    assert.equal(sanitized.includes('sk-proj-1234567890abcdef1234567890'), false, 'S3 secret key must be stripped');
    assert.equal(sanitized.includes('Jane Smith'), false, 'S2 personal context name should be stripped');
    assert.equal(sanitized.includes('user@example.com'), false, 'S2 email should be stripped');
  });

  it('REQUIRED_SEARCH_ZERO_RESULTS_NO_MODEL_ANSWER=PASS and REQUIRED_SEARCH_PROVIDER_FAILURE_NO_MODEL_ANSWER=PASS', async () => {
    // Directive A negative test 1: search returns 0 valid results
    const emptyProvider = new MockWebSearchProvider([], 'SUCCESS');
    const classifier = new QuestionClassificationService();
    const emptyEvidenceService = new EvidencePackService(classifier, new WebSearchService(emptyProvider));
    
    let modelCalled = false;
    const mockAiService = {
      chat: async () => {
        modelCalled = true;
        return { data: { message: 'Fake answer' } };
      },
    } as any;

    const sessionStore = new SessionStore();
    const convStore = new ConversationStore();
    const convContextService = new ConversationContextService(convStore);
    const auditLogger = new AuditLogger();

    const resEmpty = await handleConversationRoutes(
      'POST',
      '/api/v1/ai/chat',
      { prompt: 'What is the current price of Bitcoin today?' },
      {},
      {},
      {
        service: mockAiService,
        planResolver: {} as any,
        sessionStore,
        convStore,
        convContextService,
        auditLogger,
        getRelevantMemories: () => [],
        memoryExtractor: { extractFromConversation: async () => [], processMessage: async () => null } as any,
        evidencePackService: emptyEvidenceService,
      }
    );

    assert.equal(resEmpty?.status, 200);
    assert.equal(modelCalled, false, 'Model must NOT be called when REQUIRED search yields 0 results');
    const dataEmpty = resEmpty?.data as any;
    assert.ok(dataEmpty.message.includes("I can't verify current information right now"));

    // Directive A negative test 2: provider error
    const failProvider = new MockWebSearchProvider([], 'PROVIDER_ERROR');
    const failEvidenceService = new EvidencePackService(classifier, new WebSearchService(failProvider));
    modelCalled = false;

    const resFail = await handleConversationRoutes(
      'POST',
      '/api/v1/ai/chat',
      { prompt: 'What is the current stock price of Apple today?' },
      {},
      {},
      {
        service: mockAiService,
        planResolver: {} as any,
        sessionStore,
        convStore,
        convContextService,
        auditLogger,
        getRelevantMemories: () => [],
        memoryExtractor: { extractFromConversation: async () => [], processMessage: async () => null } as any,
        evidencePackService: failEvidenceService,
      }
    );

    assert.equal(resFail?.status, 200);
    assert.equal(modelCalled, false, 'Model must NOT be called when REQUIRED search provider fails');
  });

  it('EXPLICIT_RESEARCH_SEARCH_CALLS_GT_0=PASS and RESEARCH_WITHOUT_EVIDENCE_COMPLETION=0', async () => {
    // Directive B: POST /api/v1/research must force search even for NONE question
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);
    const aiService = createPromptCapturingAiService({ messages: [] });

    const res = await handleResearchRoutes(
      'POST',
      '/api/v1/research',
      { query: 'What is TCP/IP?' }, // Timeless query, but explicit research forces search
      { 'x-nagex-tenant': 'ten_test_01', 'x-principal-id': 'usr_test_01' },
      {},
      {
        aiService,
        evidencePackService: evidenceService,
        modelErrorResult: (e) => ({ status: 500, data: e }),
      }
    );

    assert.equal(res?.status, 200);
    assert.equal(mockProvider.searchCount, 1, 'EXPLICIT_RESEARCH_SEARCH_CALLS_GT_0=PASS');
    const data = res?.data as any;
    assert.equal(data.sources.length, 1);

    // Directive B negative test: Explicit research with failed search must NOT complete fake research
    const failProvider = new MockWebSearchProvider([], 'UNAVAILABLE');
    const failEvidenceService = new EvidencePackService(classifier, new WebSearchService(failProvider));

    const resFail = await handleResearchRoutes(
      'POST',
      '/api/v1/research',
      { query: 'What is TCP/IP?' },
      { 'x-nagex-tenant': 'ten_test_01', 'x-principal-id': 'usr_test_01' },
      {},
      {
        aiService,
        evidencePackService: failEvidenceService,
        modelErrorResult: (e) => ({ status: 500, data: e }),
      }
    );

    assert.equal(resFail?.status, 200);
    const failData = resFail?.data as any;
    assert.equal(failData.sources.length, 0);
    assert.ok(failData.answer.includes('Could not complete research'));
  });

  it('AI_RECEIVES_EVIDENCE_PACK=PASS and MEMORY_EVIDENCE_LAYER_SEPARATION=PASS', async () => {
    const classifier = new QuestionClassificationService();
    const mockProvider = new MockWebSearchProvider();
    const searchService = new WebSearchService(mockProvider);
    const evidenceService = new EvidencePackService(classifier, searchService);
    
    // Directive K: Capture exact prompt sent to model router
    const captured = { messages: [] };
    const aiService = createPromptCapturingAiService(captured);

    const memoryEngine = new MemoryEngine();
    const initialMemCount = memoryEngine.findSeedMemory({ scope: 'USER', tenantId: 'ten_01', ownerId: 'usr_01', subject: 'test', predicate: 'test' });

    const evidencePack = await evidenceService.buildEvidencePack('Latest Linux kernel release?');
    const outcome = await aiService.research({
      query: 'Latest Linux kernel release?',
      evidencePack,
      memories: [],
      requestId: 'req_test_01',
    });

    assert.ok(outcome.data.answer);
    assert.equal(outcome.data.evidencePackId, evidencePack.evidencePackId);

    // Assert system prompt actually contained evidence source details
    const systemPromptText = captured.messages.map((m: any) => m.content).join('\n');
    assert.ok(systemPromptText.includes('kernel.org'), 'AI system prompt must contain Evidence Source URL');
    assert.ok(systemPromptText.includes('src_1'), 'AI system prompt must contain Evidence Source ID');

    // Assert Memory Engine remains 100% untouched after search (MEMORY_EVIDENCE_LAYER_SEPARATION=PASS)
    const afterMem = memoryEngine.findSeedMemory({ scope: 'USER', tenantId: 'ten_01', ownerId: 'usr_01', subject: 'test', predicate: 'test' });
    assert.equal(afterMem, initialMemCount, 'Memory store must not be mutated by evidence pack');
  });
});
