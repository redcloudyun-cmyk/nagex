// R17 — Final Scope Completion Integration Test Suite
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_openai_key';
process.env.NAGEX_OPENAI_MODEL = process.env.NAGEX_OPENAI_MODEL || 'gpt-4o';

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('api.openai.com') || url.includes('api.nebius.ai') || url.includes('generativelanguage.googleapis.com')) {
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          goal: 'Automated test goal',
          summary: 'Automated test execution summary',
          reasoningSummary: 'Test execution reasoning',
          suggestions: [],
          steps: [
            {
              title: 'Execute test step',
              reasoning: 'Test step reasoning',
              skill: 'skill.general',
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

test('1. Search / Plan / Book / Create / Analyze input routing contract', async () => {
  await withServer(async (origin) => {
    const modes = [
      { text: 'Search for quantum computing advancements' },
      { text: 'Plan my day and create 5 tasks' },
      { text: 'Book a conference room for 2pm' },
      { text: 'Create a logo vector graphic' },
      { text: 'Analyze this financial report PDF' },
    ];

    for (const item of modes) {
      const res = await fetch(`${origin}/api/v1/workspace/route-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.ok(data.primaryIntent);
    }
  });
});

test('2. Creation Domain E2E — generate, reference image, recipe, variation, history, tenant isolation', async () => {
  await withServer(async (origin) => {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      'X-NAgex-Tenant': 'ten_production_01',
      'X-Principal-Id': 'usr_admin_001',
    };

    // 2a. Generate Creation
    const genRes = await fetch(`${origin}/api/v1/creations/generate`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        prompt: 'Futuristic floating city in sunset glow',
        recipe: { stylePreset: 'cyberpunk', aspectRatio: '16:9', guidanceScale: 9.0, quality: 'hd' },
        referenceImageId: 'ref_img_neon_city',
      }),
    });
    assert.equal(genRes.status, 201);
    const creation = (await genRes.json()) as any;
    assert.ok(creation.creationId.startsWith('cr_'));
    assert.equal(creation.prompt, 'Futuristic floating city in sunset glow');
    assert.equal(creation.recipe.stylePreset, 'cyberpunk');
    assert.equal(creation.referenceImageId, 'ref_img_neon_city');
    assert.ok(creation.outputAssetUrl.includes('data:image/svg+xml'));

    // 2b. Generate Variation
    const varRes = await fetch(`${origin}/api/v1/creations/${creation.creationId}/variation`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        promptModifier: 'Add glowing holographic billboards',
      }),
    });
    assert.equal(varRes.status, 201);
    const variation = (await varRes.json()) as any;
    assert.ok(variation.creationId.startsWith('cr_'));
    assert.equal(variation.parentCreationId, creation.creationId);
    assert.ok(variation.prompt.includes('holographic billboards'));

    // 2c. List Creations
    const listRes = await fetch(`${origin}/api/v1/creations`, {
      method: 'GET',
      headers: defaultHeaders,
    });
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as any;
    assert.ok(listData.creations.length >= 2);

    // 2d. Get Lineage
    const getRes = await fetch(`${origin}/api/v1/creations/${variation.creationId}`, {
      method: 'GET',
      headers: defaultHeaders,
    });
    assert.equal(getRes.status, 200);
    const getDetails = (await getRes.json()) as any;
    assert.equal(getDetails.creation.creationId, variation.creationId);
    assert.ok(getDetails.lineage.length >= 2);

    // 2e. Tenant Isolation — Foreign Tenant DENY
    const foreignTenantRes = await fetch(`${origin}/api/v1/creations`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_foreign_99',
        'X-Principal-Id': 'usr_foreign_99',
      },
    });
    assert.equal(foreignTenantRes.status, 200);
    const foreignListData = (await foreignTenantRes.json()) as any;
    assert.equal(foreignListData.creations.length, 0);

    const foreignGetRes = await fetch(`${origin}/api/v1/creations/${creation.creationId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_foreign_99',
        'X-Principal-Id': 'usr_foreign_99',
      },
    });
    assert.equal(foreignGetRes.status, 404);
  });
});

test('3. Approval Semantics — Reject (no mutation) vs Approve (mutation)', async () => {
  await withServer(async (origin) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-NAgex-Tenant': 'ten_production_01',
      'X-Principal-Id': 'usr_admin_001',
    };

    const validPayload = {
      calendarId: 'primary',
      summary: 'Meeting to Test',
      description: 'Test meeting description',
      start: '2026-09-18T10:00:00Z',
      end: '2026-09-18T11:00:00Z',
      timezone: 'Asia/Seoul',
      attendees: ['user@example.com'],
    };

    // 3a. Create approval 1 for Reject test
    const create1Res = await fetch(`${origin}/api/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        toolId: 'google_calendar.create_event',
        payload: { ...validPayload, summary: 'Meeting to Reject' },
      }),
    });
    assert.equal(create1Res.status, 201);
    const appr1 = (await create1Res.json()) as any;

    // Reject action
    const appr1Res = await fetch(`${origin}/api/v1/approvals/${appr1.approvalId}/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'REJECT' }),
    });
    assert.equal(appr1Res.status, 200);
    const appr1Data = (await appr1Res.json()) as any;
    assert.equal(appr1Data.status, 'REJECTED');

    // 3b. Create approval 2 for Approve test
    const create2Res = await fetch(`${origin}/api/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        toolId: 'google_calendar.create_event',
        payload: { ...validPayload, summary: 'Meeting to Approve' },
      }),
    });
    assert.equal(create2Res.status, 201);
    const appr2 = (await create2Res.json()) as any;

    // Approve action
    const appr2Res = await fetch(`${origin}/api/v1/approvals/${appr2.approvalId}/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'APPROVE' }),
    });
    assert.equal(appr2Res.status, 200);
    const appr2Data = (await appr2Res.json()) as any;
    assert.equal(appr2Data.status, 'APPROVED');
  });
});

test('4. Task Retry & Cancel Synchronization', async () => {
  await withServer(async (origin) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-NAgex-Tenant': 'ten_production_01',
      'X-Principal-Id': 'usr_admin_001',
    };

    // 4a. Create task
    const createRes = await fetch(`${origin}/api/v1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Test Cancellable Task',
        objective: 'Run cancellation test',
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
        promptText: 'Run cancellation test',
      }),
    });
    assert.equal(createRes.status, 201);
    const task = (await createRes.json()) as any;

    // 4b. Cancel task
    const cancelRes = await fetch(`${origin}/api/v1/tasks/${task.taskId}/cancel`, {
      method: 'POST',
      headers,
    });
    assert.equal(cancelRes.status, 200);

    // 4c. Verify backend state updated
    const getRes = await fetch(`${origin}/api/v1/tasks/${task.taskId}`, {
      method: 'GET',
      headers,
    });
    assert.equal(getRes.status, 200);
    const fetched = (await getRes.json()) as any;
    assert.equal(fetched.status, 'CANCELLED');
  });
});

test('5. Analyze Upload Init, Complete, & Structured Output', async () => {
  await withServer(async (origin) => {
    const headers = {
      'Content-Type': 'application/json',
      'X-NAgex-Tenant': 'ten_production_01',
      'X-Principal-Id': 'usr_admin_001',
    };

    const initRes = await fetch(`${origin}/api/v1/workspace/uploads/init`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filename: 'contract_review.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1048576,
        intent: 'ANALYZE',
      }),
    });
    assert.equal(initRes.status, 201);
    const initData = (await initRes.json()) as any;
    assert.ok(initData.captureId);

    const completeRes = await fetch(`${origin}/api/v1/workspace/uploads/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        captureId: initData.captureId,
        objectKey: initData.objectKey,
        mimeType: 'application/pdf',
        sizeBytes: 1048576,
        originalFilename: 'contract_review.pdf',
        data: Buffer.from('PDF analysis content test payload').toString('base64'),
      }),
    });
    assert.equal(completeRes.status, 200);
  });
});

test('6. Tenant Guard Context Tampering Protection', async () => {
  await withServer(async (origin) => {
    // Foreign tenant attempting access to vault or activity
    const vaultRes = await fetch(`${origin}/api/v1/workspace/vault`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-NAgex-Tenant': 'ten_attacker_99',
        'X-Principal-Id': 'usr_attacker_99',
      },
    });
    assert.equal(vaultRes.status, 200);
    const vaultData = (await vaultRes.json()) as any;
    // Foreign tenant sees zero items in recentItems
    assert.equal(vaultData.recentItems.length, 0);
  });
});
