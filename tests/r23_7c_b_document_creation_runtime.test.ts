import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';
import { CreationRuntime } from '../src/creation/creation-runtime.js';
import { DocumentExecutor } from '../src/creation/executors/document-executor.js';
import { DocumentStore } from '../src/creation/document.store.js';
import { ArtifactStore } from '../src/artifacts/artifact.store.js';
import { handleDocumentCreationRoutes } from '../src/http/routes/document-creation.routes.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => {
    instance.listen(0, '127.0.0.1', () => resolve());
    instance.once('error', reject);
  });
  const addr = instance.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    if (typeof (instance as any).closeIdleConnections === 'function') {
      (instance as any).closeIdleConnections();
    }
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
}

// ── Unit & Contract Tests for CreationRuntime & DocumentExecutor ──

test('A. Successful document creation via DocumentExecutor & CreationRuntime', async () => {
  const mockAiService: any = {
    documentSynthesis: async (input: any) => ({
      data: {
        title: 'Q3 Market Strategy Report',
        summary: 'Executive summary of market expansion risks and strategy.',
        content: '# Q3 Market Strategy Report\n\n## 1. Executive Summary\nMarket expansion presents high growth potential.',
      },
      provider: 'nebius',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      latencyMs: 120,
      requestId: input.requestId,
    }),
  };

  const documentStore = new DocumentStore();
  const artifactStore = new ArtifactStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore, artifactStore });
  const runtime = new CreationRuntime([executor]);

  const result = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Create a Q3 Market Strategy Report',
    tenantId: 'ten_test_a',
    ownerId: 'usr_test_a',
    requestId: 'req_test_a_001',
    options: { locale: 'en', documentKind: 'REPORT' },
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.title, 'Q3 Market Strategy Report');
  assert.ok(result.creationId.startsWith('doc_'));
  assert.ok(result.openTarget.includes(result.creationId));
  assert.equal(result.metadata?.provider, 'nebius');

  // Verify persistence in DocumentStore & ArtifactStore
  const storedDoc = documentStore.get(result.creationId, 'ten_test_a', 'usr_test_a');
  assert.ok(storedDoc);
  assert.equal(storedDoc.title, 'Q3 Market Strategy Report');

  const artifacts = artifactStore.list('ten_test_a', 'usr_test_a');
  const matchingArtifact = artifacts.find((a) => a.sourceId === result.creationId);
  assert.ok(matchingArtifact);
  assert.equal(matchingArtifact.type, 'DOCUMENT');
});

test('B. Provider unavailable returns UNAVAILABLE or FAILED without fake fallback', async () => {
  const mockAiService: any = {
    documentSynthesis: async () => {
      const err: any = new Error('No model provider available for task DOCUMENT_SYNTHESIS');
      err.code = 'NO_MODEL_PROVIDER_CONFIGURED';
      throw err;
    },
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  const result = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Create an analysis document',
    tenantId: 'ten_test_b',
    ownerId: 'usr_test_b',
    requestId: 'req_test_b_001',
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'NO_MODEL_PROVIDER_CONFIGURED');
  assert.equal(result.creationId, '');

  // Verify FAKE_SUCCESS_PATHS = 0 (no document or artifact persisted)
  const docs = documentStore.list('ten_test_b', 'usr_test_b');
  assert.equal(docs.length, 0);
});

test('C. Provider throws error returns FAILED state truthfully', async () => {
  const mockAiService: any = {
    documentSynthesis: async () => {
      throw new Error('Provider rate limit exceeded (429)');
    },
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  const result = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Generate meeting notes',
    tenantId: 'ten_test_c',
    ownerId: 'usr_test_c',
    requestId: 'req_test_c_001',
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorMessage, 'Provider rate limit exceeded (429)');
});

test('E & F. Empty or whitespace response from provider is rejected truthfully', async () => {
  const mockAiService: any = {
    documentSynthesis: async () => ({
      data: { title: '   ', summary: '', content: '   \n  ' },
      provider: 'nebius',
      model: 'llama',
      latencyMs: 50,
      requestId: 'req_empty',
    }),
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  const result = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Generate product pitch',
    tenantId: 'ten_test_ef',
    ownerId: 'usr_test_ef',
    requestId: 'req_test_ef_001',
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'EMPTY_GENERATION');
});

test('H & I. Unauthorized and Cross-Tenant document retrieval is strictly DENIED', async () => {
  const mockAiService: any = {
    documentSynthesis: async () => ({
      data: { title: 'Secret Financial Proposal', summary: 'Confidential', content: 'Secret budget numbers' },
      provider: 'openai',
      model: 'gpt-4o',
      latencyMs: 100,
      requestId: 'req_secret',
    }),
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  const created = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Secret Financial Proposal',
    tenantId: 'tenant_alpha',
    ownerId: 'user_alice',
    requestId: 'req_sec_01',
  });

  assert.equal(created.status, 'SUCCESS');
  const docId = created.creationId;

  // Alice can retrieve her own document
  const aliceDoc = documentStore.get(docId, 'tenant_alpha', 'user_alice');
  assert.ok(aliceDoc);

  // Bob (different user in same tenant) attempt -> NULL (DENIED)
  const bobDoc = documentStore.get(docId, 'tenant_alpha', 'user_bob');
  assert.equal(bobDoc, null);

  // Eve (different tenant) attempt -> NULL (DENIED)
  const eveDoc = documentStore.get(docId, 'tenant_beta', 'user_eve');
  assert.equal(eveDoc, null);
});

test('K & L. Locale-influenced document generation (EN and KR)', async () => {
  let capturedLocale: string | undefined;
  const mockAiService: any = {
    documentSynthesis: async (input: any) => {
      capturedLocale = input.locale;
      return {
        data: {
          title: input.locale === 'ko' ? '제품 출시 위험 분석 보고서' : 'Product Launch Risk Analysis',
          summary: input.locale === 'ko' ? '핵심 위험요소 요약' : 'Summary of key risks',
          content: input.locale === 'ko' ? '# 위험 분석' : '# Risk Analysis',
        },
        provider: 'gemini',
        model: 'gemini-1.5-pro',
        latencyMs: 150,
        requestId: input.requestId,
      };
    },
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });
  const runtime = new CreationRuntime([executor]);

  // Korean request
  const krResult = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: '제품 출시 위험 분석 보고서 작성해줘',
    tenantId: 'ten_locale',
    ownerId: 'usr_locale',
    requestId: 'req_kr_01',
    options: { locale: 'ko' },
  });
  assert.equal(krResult.status, 'SUCCESS');
  assert.equal(capturedLocale, 'ko');
  assert.equal(krResult.title, '제품 출시 위험 분석 보고서');

  // English request
  const enResult = await runtime.create({
    creationKind: 'DOCUMENT',
    prompt: 'Create product launch risk analysis',
    tenantId: 'ten_locale',
    ownerId: 'usr_locale',
    requestId: 'req_en_01',
    options: { locale: 'en' },
  });
  assert.equal(enResult.status, 'SUCCESS');
  assert.equal(capturedLocale, 'en');
  assert.equal(enResult.title, 'Product Launch Risk Analysis');
});

test('Revision flow produces a revision child referencing parent document', async () => {
  const mockAiService: any = {
    documentSynthesis: async (input: any) => ({
      data: {
        title: input.prompt.includes('Existing Document') ? 'Q3 Market Report (Executive Summary Added)' : 'Q3 Market Report',
        summary: 'Revised summary for executive leadership.',
        content: '# Q3 Market Report\n\n## Executive Summary\nAdded for leadership review.',
      },
      provider: 'nebius',
      model: 'llama',
      latencyMs: 100,
      requestId: input.requestId,
    }),
  };

  const documentStore = new DocumentStore();
  const executor = new DocumentExecutor({ aiService: mockAiService, documentStore });

  // Initial creation
  const doc1 = await executor.execute({
    creationKind: 'DOCUMENT',
    prompt: 'Draft Q3 Market Report',
    tenantId: 'ten_rev',
    ownerId: 'usr_rev',
    requestId: 'req_rev_01',
  });
  assert.equal(doc1.status, 'SUCCESS');

  // Revision request
  const rev = await executor.executeRevision({
    parentDocumentId: doc1.creationId,
    instruction: 'Add an executive summary at the top for C-level executives',
    tenantId: 'ten_rev',
    ownerId: 'usr_rev',
    requestId: 'req_rev_02',
  });
  assert.equal(rev.status, 'SUCCESS');

  const revisions = documentStore.getRevisions(doc1.creationId, 'ten_rev', 'usr_rev');
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].documentId, doc1.creationId);
  assert.equal(revisions[1].parentDocumentId, doc1.creationId);
  assert.equal(revisions[1].revisionIndex, 2);
});

// ── HTTP Route Handler Contract Tests ──

test('handleDocumentCreationRoutes POST, GET, and Revisions contract', async () => {
  const mockAiService: any = {
    documentSynthesis: async (input: any) => ({
      data: {
        title: 'Q4 Competitive Brief',
        summary: 'Competitive analysis brief for Q4 launch.',
        content: '# Q4 Competitive Brief\n\nDetailed breakdown.',
      },
      provider: 'nebius',
      model: 'llama-3.3-70b',
      latencyMs: 90,
      requestId: input.requestId,
    }),
  };

  const documentStore = new DocumentStore();
  const artifactStore = new ArtifactStore();
  const documentExecutor = new DocumentExecutor({ aiService: mockAiService, documentStore, artifactStore });
  const creationRuntime = new CreationRuntime([documentExecutor]);

  const headers = {
    'x-nagex-tenant': 'ten_route_test',
    'x-principal-id': 'usr_route_test',
    'x-request-id': 'req_route_001',
  };

  // 1. POST /api/v1/creations/documents
  const postRes = await handleDocumentCreationRoutes('POST', '/api/v1/creations/documents', {
    prompt: 'Create Q4 Competitive Brief',
    documentKind: 'PROPOSAL',
    locale: 'en',
  }, headers, {}, { creationRuntime, documentExecutor, documentStore });

  assert.ok(postRes);
  assert.equal(postRes.status, 201);
  const data = postRes.data as any;
  assert.equal(data.status, 'SUCCESS');
  assert.ok(data.creationId);

  const docId = data.creationId;

  // 2. GET /api/v1/creations/documents/:id
  const getRes = await handleDocumentCreationRoutes('GET', `/api/v1/creations/documents/${docId}`, null, headers, {}, { creationRuntime, documentExecutor, documentStore });
  assert.ok(getRes);
  assert.equal(getRes.status, 200);
  const getData = getRes.data as any;
  assert.equal(getData.document.documentId, docId);
  assert.equal(getData.document.title, 'Q4 Competitive Brief');

  // 3. POST /api/v1/creations/documents/:id/revisions
  const revRes = await handleDocumentCreationRoutes('POST', `/api/v1/creations/documents/${docId}/revisions`, {
    instruction: 'Shorten to one page',
  }, headers, {}, { creationRuntime, documentExecutor, documentStore });
  assert.ok(revRes);
  assert.equal(revRes.status, 201);

  // 4. GET /api/v1/creations/documents/:id for non-existent document -> 404
  const notFoundRes = await handleDocumentCreationRoutes('GET', '/api/v1/creations/documents/doc_non_existent', null, headers, {}, { creationRuntime, documentExecutor, documentStore });
  assert.ok(notFoundRes);
  assert.equal(notFoundRes.status, 404);

  // 5. GET /api/v1/creations/documents/:id with wrong owner -> 404 (DENIED)
  const deniedRes = await handleDocumentCreationRoutes('GET', `/api/v1/creations/documents/${docId}`, null, {
    ...headers,
    'x-principal-id': 'usr_attacker',
  }, {}, { creationRuntime, documentExecutor, documentStore });
  assert.ok(deniedRes);
  assert.equal(deniedRes.status, 404);
});

test('Truthful failure when unconfigured model provider receives document request over HTTP', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/v1/creations/documents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nagex-tenant': 'ten_unconfigured',
        'x-principal-id': 'usr_unconfigured',
      },
      body: JSON.stringify({
        prompt: 'Create unconfigured test doc',
      }),
    });

    // When model provider is not configured or fails, HTTP route returns 500 or 503 error status
    // and NEVER returns fake success or fake mock artifact
    assert.ok(res.status === 500 || res.status === 503);
    const body = (await res.json()) as any;
    assert.ok(body.error);
    assert.notEqual(body.status, 'SUCCESS');
  });
});
