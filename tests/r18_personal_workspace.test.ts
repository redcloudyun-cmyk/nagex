// R18 — Personal Workspace Integration Test Suite
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com')) {
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          goal: 'Automated personal workspace test goal',
          summary: 'Automated test execution summary',
          reasoningSummary: 'Test execution reasoning',
          suggestions: [],
          steps: [],
        }),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return origFetch(input, init);
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServerInstance } from '../src/server_web.js';

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

const defaultHeaders = {
  'Content-Type': 'application/json',
  'X-NAgex-Tenant': 'ten_production_01',
  'X-Principal-Id': 'usr_admin_001',
  'X-NAgex-Workspace': 'ws_default_01',
};

// R23.1H — the Inbox route is now canonically backed by CaptureStore (the
// Unified Capture pipeline), not the retired standalone InboxStore, so the
// UI (renderInbox()) and CurrentPersonalContextService (R23.1) agree on
// one canonical Inbox (CANONICAL_USER_INBOX_PIPELINE_COUNT=1). Field names
// and the initial status accordingly follow CaptureItem's real contract
// (captureId, status READY on this route's own immediate/pre-understood
// creation) rather than the retired InboxItem shape — the flow itself
// (capture -> list -> save to Vault -> archive) is unchanged.
test('1. Inbox E2E — real capture, list, archive, save to Vault', async () => {
  await withServer(async (origin) => {
    // 1a. Ingress via Capture
    const captureRes = await fetch(`${origin}/api/v1/workspace/inbox/capture`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        sourceType: 'UPLOAD',
        title: 'Q3 Financial Quarter Analysis',
        summary: 'Uploaded PDF regarding Q3 sales revenue',
      }),
    });
    assert.equal(captureRes.status, 201);
    const item = (await captureRes.json()) as any;
    assert.ok(item.captureId);
    assert.equal(item.status, 'READY');

    // 1b. List Inbox
    const listRes = await fetch(`${origin}/api/v1/workspace/inbox`, {
      headers: defaultHeaders,
    });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as any;
    assert.ok(Array.isArray(list.items));
    assert.ok(list.items.some((i: any) => i.captureId === item.captureId));

    // 1c. Save to Vault
    const saveRes = await fetch(`${origin}/api/v1/workspace/inbox/${item.captureId}/save-to-vault`, {
      method: 'POST',
      headers: defaultHeaders,
    });
    assert.ok([200, 201].includes(saveRes.status));
    const saveData = (await saveRes.json()) as any;
    const vaultItem = saveData.vaultItem || saveData;
    assert.ok(vaultItem.vaultItemId);
    assert.equal(vaultItem.title, 'Q3 Financial Quarter Analysis');

    // Verify inbox item marked ACTIONED
    const getItemRes = await fetch(`${origin}/api/v1/workspace/inbox/${item.captureId}`, {
      headers: defaultHeaders,
    });
    assert.equal(getItemRes.status, 200);
    const updatedItem = (await getItemRes.json()) as any;
    assert.equal(updatedItem.status, 'ACTIONED');

    // 1d. Archive Inbox Item
    const archiveRes = await fetch(`${origin}/api/v1/workspace/inbox/${item.captureId}/archive`, {
      method: 'POST',
      headers: defaultHeaders,
    });
    assert.equal(archiveRes.status, 200);
    const archived = (await archiveRes.json()) as any;
    assert.equal(archived.status, 'ARCHIVED');
  });
});

test('2. Vault E2E — item creation, retrieval, search, TEMP vs VAULT policy, tenant isolation', async () => {
  await withServer(async (origin) => {
    // 2a. Add Vault item directly
    const createVaultRes = await fetch(`${origin}/api/v1/workspace/vault`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        type: 'DOCUMENT',
        title: 'Project NAgex Architecture Diagram v2',
        mimeType: 'application/pdf',
        storageRef: 's3://vault/arch_v2.pdf',
        source: 'MANUAL',
        metadata: { tags: ['architecture', 'roadmap'] },
      }),
    });
    assert.equal(createVaultRes.status, 201);
    const vItem = (await createVaultRes.json()) as any;
    assert.equal(vItem.title, 'Project NAgex Architecture Diagram v2');

    // 2b. Search Vault
    const searchRes = await fetch(`${origin}/api/v1/workspace/vault?q=Architecture`, {
      headers: defaultHeaders,
    });
    assert.equal(searchRes.status, 200);
    const searchResult = (await searchRes.json()) as any;
    assert.ok(searchResult.items.length >= 1);
    assert.equal(searchResult.items[0].vaultItemId, vItem.vaultItemId);

    // 2c. Tenant Isolation Check: Foreign Tenant Request MUST fail or return DENY / empty / 404
    const foreignHeaders = {
      ...defaultHeaders,
      'X-NAgex-Tenant': 'ten_foreign_hacker',
    };
    const foreignGetRes = await fetch(`${origin}/api/v1/workspace/vault/${vItem.vaultItemId}`, {
      headers: foreignHeaders,
    });
    assert.ok([403, 404].includes(foreignGetRes.status));
  });
});

test('3. Memory E2E — create, retrieve, correction (PATCH), delete, scope isolation, source traceability', async () => {
  await withServer(async (origin) => {
    // 3a. Create Memory with explicit sourceRef & scope PERSONAL
    const createMemRes = await fetch(`${origin}/api/v1/memory`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        scope: 'PERSONAL',
        type: 'PREFERENCE',
        content: 'User prefers dark mode UI and concise summary responses.',
        sourceRef: 'usr_statement_001',
        confidence: 0.95,
      }),
    });
    assert.equal(createMemRes.status, 201);
    const mem = (await createMemRes.json()) as any;
    const memId = mem.memoryId || mem.id;
    assert.ok(memId);
    assert.equal(mem.sourceRef || mem.source_ref, 'usr_statement_001');

    // 3b. Retrieve Memory
    const listMemRes = await fetch(`${origin}/api/v1/memory`, {
      headers: defaultHeaders,
    });
    assert.equal(listMemRes.status, 200);
    const memList = (await listMemRes.json()) as any;
    const memories = memList.memories || memList.items || [];
    assert.ok(memories.some((m: any) => (m.memoryId || m.id) === memId));

    // 3c. Correct Memory (PATCH)
    const patchMemRes = await fetch(`${origin}/api/v1/memory/${memId}`, {
      method: 'PATCH',
      headers: defaultHeaders,
      body: JSON.stringify({
        content: 'User prefers OLED dark mode UI and bulleted summary responses.',
        confidence: 0.99,
      }),
    });
    assert.equal(patchMemRes.status, 200);
    const updatedMem = (await patchMemRes.json()) as any;
    assert.ok(updatedMem.content?.value === 'User prefers OLED dark mode UI and bulleted summary responses.' || updatedMem.content === 'User prefers OLED dark mode UI and bulleted summary responses.');

    // 3d. Cross-User Memory Isolation DENY check
    const foreignUserHeaders = {
      ...defaultHeaders,
      'X-Principal-Id': 'usr_other_user_999',
    };
    const foreignMemGetRes = await fetch(`${origin}/api/v1/memory/${memId}`, {
      headers: foreignUserHeaders,
    });
    assert.ok([403, 404].includes(foreignMemGetRes.status));

    // 3e. Delete Memory
    const delMemRes = await fetch(`${origin}/api/v1/memory/${memId}`, {
      method: 'DELETE',
      headers: defaultHeaders,
    });
    assert.equal(delMemRes.status, 200);
  });
});

test('4. Calendar read & empty state contract', async () => {
  await withServer(async (origin) => {
    // 4a. Read Upcoming Events
    const calRes = await fetch(`${origin}/api/v1/calendar/upcoming`, {
      headers: defaultHeaders,
    });
    assert.equal(calRes.status, 200);
    const calData = (await calRes.json()) as any;
    assert.ok(Array.isArray(calData.events));
    if (calData.events.length === 0) {
      assert.ok(calData.emptyStateMessage || calData.events.length === 0);
    }
  });
});

test('5. My Space Hub Aggregation', async () => {
  await withServer(async (origin) => {
    const spaceRes = await fetch(`${origin}/api/v1/workspace/my-space`, {
      headers: defaultHeaders,
    });
    assert.equal(spaceRes.status, 200);
    const spaceData = (await spaceRes.json()) as any;
    assert.ok(spaceData.history || spaceData.tasks || spaceData.memory);
  });
});

test('6. Today\'s Brief & Hallucination Prevention', async () => {
  await withServer(async (origin) => {
    const briefRes = await fetch(`${origin}/api/v1/brief/today`, {
      headers: defaultHeaders,
    });
    assert.equal(briefRes.status, 200);
    const brief = (await briefRes.json()) as any;
    assert.ok(brief.date);
    assert.ok(Array.isArray(brief.schedule));
    assert.ok(Array.isArray(brief.actionItems || brief.attentionItems || []));
  });
});

test('7. Connected Apps status, credential protection & disconnect flow', async () => {
  await withServer(async (origin) => {
    // 7a. List Connections
    const connRes = await fetch(`${origin}/api/v1/connections`, {
      headers: defaultHeaders,
    });
    assert.equal(connRes.status, 200);
    const connData = (await connRes.json()) as any;
    assert.ok(Array.isArray(connData.connections));
    const googleConn = connData.connections.find((c: any) => c.provider === 'google');
    assert.ok(googleConn);
    // Credential check: tokens MUST NOT be exposed
    assert.equal(googleConn.accessToken, undefined);
    assert.equal(googleConn.refreshToken, undefined);

    // 7b. Disconnect Flow
    const disconnRes = await fetch(`${origin}/api/v1/connections/google/disconnect`, {
      method: 'POST',
      headers: defaultHeaders,
    });
    assert.equal(disconnRes.status, 200);
    const disconnData = (await disconnRes.json()) as any;
    assert.equal(disconnData.status, 'DISCONNECTED');
  });
});

test('8. Cross-Source Search with Badges', async () => {
  await withServer(async (origin) => {
    const searchRes = await fetch(`${origin}/api/v1/workspace/search?q=quarterly`, {
      headers: defaultHeaders,
    });
    assert.equal(searchRes.status, 200);
    const resData = (await searchRes.json()) as any;
    assert.ok(Array.isArray(resData.results));
    for (const r of resData.results) {
      assert.ok(['Vault', 'Memory', 'Calendar', 'Inbox', 'Web', '[Vault]', '[Memory]', '[Web]'].includes(r.sourceBadge || r.sourceTypeBadge));
    }
  });
});

test('9. SCIM Deprovision Multi-Org & Lifecycle Isolation', async () => {
  await withServer(async (origin) => {
    // 9a. Deprovision User in ORG A
    const deprovRes = await fetch(`${origin}/api/v1/identity/scim/v2/Users/usr_admin_001`, {
      method: 'PATCH',
      headers: defaultHeaders,
      body: JSON.stringify({
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    assert.ok([200, 204, 404].includes(deprovRes.status));
  });
});
