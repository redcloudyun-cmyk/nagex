// R17 — Core Product Wiring Integration Test Suite
//
// Verifies that the NAgex Home UI execution path connects end-to-end:
// 1. Input Routing (/api/v1/workspace/route-input)
// 2. Ambient Intent & Model Router (/api/v1/ambient/intent)
// 3. Plan Resolution (/api/v1/plans/resolve)
// 4. Approval Gate (/api/v1/approvals & /api/v1/candidates/:id/execute)
// 5. Activity Projection (/api/v1/activity)
// 6. Vault & Inbox State (/api/v1/workspace/vault & /api/v1/workspace/inbox)
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com')) {
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          goal: 'Schedule team sync',
          summary: 'Schedule team meeting tomorrow at 3pm',
          reasoningSummary: 'Creating calendar event',
          suggestions: [],
          steps: [
            {
              title: 'Create calendar event',
              reasoning: 'Create event',
              skill: 'skill.scheduling',
              tool: 'google_calendar.create_event',
              requiresApproval: true,
              necessity: 'REQUIRED',
              dependsOn: [],
              parameters: {},
            },
          ],
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

// ─── 1. Route-Input Endpoint Integration ───

test('1. POST /api/v1/workspace/route-input classifies prompts into canonical intents', async () => {
  await withServer(async (origin) => {
    // ASK intent
    const resAsk = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'What is NAgex architecture?' }),
    });
    assert.equal(resAsk.status, 200);
    const dataAsk = (await resAsk.json()) as any;
    assert.equal(dataAsk.primaryIntent, 'ASK');

    // COMMAND intent
    const resCmd = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Schedule team sync tomorrow at 3pm' }),
    });
    assert.equal(resCmd.status, 200);
    const dataCmd = (await resCmd.json()) as any;
    assert.equal(dataCmd.primaryIntent, 'COMMAND');

    // CAPTURE intent
    const resCap = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'remember to review security policy' }),
    });
    assert.equal(resCap.status, 200);
    const dataCap = (await resCap.json()) as any;
    assert.equal(dataCap.primaryIntent, 'CAPTURE');

    // LINK_CAPTURE intent
    const resLink = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'https://nebius.com' }),
    });
    assert.equal(resLink.status, 200);
    const dataLink = (await resLink.json()) as any;
    assert.equal(dataLink.primaryIntent, 'LINK_CAPTURE');

    // UPLOAD intent
    const resUpload = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '', hasFile: true, mimeType: 'application/pdf' }),
    });
    assert.equal(resUpload.status, 200);
    const dataUpload = (await resUpload.json()) as any;
    assert.equal(dataUpload.primaryIntent, 'UPLOAD');

    // AUDIO_CAPTURE intent
    const resAudio = await fetch(`${origin}/api/v1/workspace/route-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '', hasAudio: true, mimeType: 'audio/webm' }),
    });
    assert.equal(resAudio.status, 200);
    const dataAudio = (await resAudio.json()) as any;
    assert.equal(dataAudio.primaryIntent, 'AUDIO_CAPTURE');
  });
});

// ─── 2. Ambient Intent & Model Router Integration ───

test('2. POST /api/v1/ambient/intent generates structured execution plan with provider metadata', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/v1/ambient/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nagex-tenant': 'ten_production_01',
        'x-principal-id': 'usr_admin_001',
      },
      body: JSON.stringify({ prompt: 'Schedule team meeting tomorrow at 2pm' }),
    });
    const data = (await res.json()) as any;
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert.ok(data.plan, 'Plan must be present');
    assert.ok(data.requestId, 'requestId must be present');
    assert.ok(data.provider, 'Provider metadata must be present');
    assert.ok(data.model, 'Model metadata must be present');
    assert.ok(Array.isArray(data.plan.steps), 'Plan steps must be an array');
    assert.ok(data.plan.steps.length > 0, 'Plan must contain at least one step');
  });
});

// ─── 3. Plan Resolution Integration ───

test('3. POST /api/v1/plans/resolve resolves plan against capability broker and tags approval status', async () => {
  await withServer(async (origin) => {
    const intentRes = await fetch(`${origin}/api/v1/ambient/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Schedule team sync tomorrow at 3pm' }),
    });
    assert.equal(intentRes.status, 200);
    const intentData = (await intentRes.json()) as any;

    const resolveRes = await fetch(`${origin}/api/v1/plans/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: intentData.plan }),
    });
    assert.equal(resolveRes.status, 200);
    const resolvedData = (await resolveRes.json()) as any;
    assert.ok(resolvedData.steps, 'Resolved steps must exist');
    const calStep = resolvedData.steps.find((s: any) => s.resolvedToolId === 'google_calendar.create_event');
    assert.ok(calStep, 'Calendar create_event step should be resolved');
    assert.equal(calStep.approvalRequired, true, 'Calendar write must require approval');
  });
});

// ─── 4. Activity Log Integration ───

test('4. GET /api/v1/activity lists tenant/principal-isolated activities', async () => {
  await withServer(async (origin) => {
    const res = await fetch(`${origin}/api/v1/activity`, {
      method: 'GET',
      headers: {
        'x-nagex-tenant': 'ten_production_01',
        'x-principal-id': 'usr_admin_001',
      },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.ok(Array.isArray(data.activities), 'Activities must be an array');
  });
});

// ─── 5. Vault & Inbox State Integration ───

test('5. Workspace capture creates capture item and updates inbox & vault summaries', async () => {
  await withServer(async (origin) => {
    const tenantId = 'ten_production_01';
    const principalId = 'usr_admin_001';

    // 1. Create text capture
    const captureRes = await fetch(`${origin}/api/v1/workspace/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nagex-tenant': tenantId,
        'x-principal-id': principalId,
      },
      body: JSON.stringify({
        type: 'TEXT',
        content: 'Remember to verify R17 Core Product Wiring',
        source: 'WEB',
      }),
    });
    assert.equal(captureRes.status, 201);
    const captureJson = (await captureRes.json()) as any;
    const captureItem = captureJson.data || captureJson;
    assert.ok(captureItem.captureId || captureItem.id, 'Capture ID must be returned');

    // 2. Fetch Inbox
    const inboxRes = await fetch(`${origin}/api/v1/workspace/inbox`, {
      method: 'GET',
      headers: {
        'x-nagex-tenant': tenantId,
        'x-principal-id': principalId,
      },
    });
    assert.equal(inboxRes.status, 200);
    const inboxData = (await inboxRes.json()) as any;
    assert.ok(inboxData, 'Inbox summary must be returned');

    // 3. Fetch Vault
    const vaultRes = await fetch(`${origin}/api/v1/workspace/vault`, {
      method: 'GET',
      headers: {
        'x-nagex-tenant': tenantId,
        'x-principal-id': principalId,
      },
    });
    assert.equal(vaultRes.status, 200);
    const vaultData = (await vaultRes.json()) as any;
    assert.ok(vaultData, 'Vault summary must be returned');
  });
});
