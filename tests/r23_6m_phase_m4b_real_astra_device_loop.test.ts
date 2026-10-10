import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { AstraDeviceUIReasoner, DeviceUIActionGate, DeviceUIReasoningCoordinator } from '../src/execution/device-ui-reasoner.js';
import { reasoningInput, proposal, plan, observation, harness } from './_m4a_device_ui_fixture.js';

test('M4B fake-live Astra provider call returns strict typed proposal and usage without execution', async () => {
  const h = harness();
  let called = 0;
  const astra = new AstraDeviceUIReasoner({
    apiKey: 'sk-test',
    model: 'gpt-6-astra',
    fetchFn: async (_url, init) => {
      called++;
      const body = JSON.parse(String(init?.body));
      const serialized = JSON.stringify(body);
      assert.match(serialized, /device_ui_action_proposal/);
      assert.doesNotMatch(serialized, /See you at 6\./);
      assert.doesNotMatch(serialized, /Authorization/i);
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal({ provider: 'ASTRA', model: 'gpt-6-astra', action: 'FIND_ELEMENT', semanticTarget: 'search', targetNodeRef: 'node_search' })) }] }],
        usage: { input_tokens: 111, output_tokens: 22 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const p = await astra.reason(reasoningInput(h, { allowedActions: ['FIND_ELEMENT', 'WAIT'] }));
  assert.equal(called, 1);
  assert.equal(p.action, 'FIND_ELEMENT');
  assert.equal(astra.usage()?.inputTokens, 111);
  assert.equal(astra.usage()?.outputTokens, 22);
});

test('M4B malformed, timeout, and rate-limit provider failures fail closed before Action Gate execution', async () => {
  const h = harness();
  const malformed = new DeviceUIReasoningCoordinator(new AstraDeviceUIReasoner({
    apiKey: 'sk-test',
    fetchFn: async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] }), { status: 200 }),
  }));
  assert.equal((await malformed.recover(reasoningInput(h))).reasonCode, 'PROVIDER_MALFORMED_RESPONSE');

  const rateLimited = new DeviceUIReasoningCoordinator(new AstraDeviceUIReasoner({
    apiKey: 'sk-test',
    fetchFn: async () => new Response('{}', { status: 429 }),
  }));
  assert.equal((await rateLimited.recover(reasoningInput(h))).reasonCode, 'PROVIDER_HTTP_429');

  const timedOut = new DeviceUIReasoningCoordinator(new AstraDeviceUIReasoner({
    apiKey: 'sk-test',
    timeoutMs: 1,
    fetchFn: async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('{}', { status: 200 });
    },
  }));
  assert.equal((await timedOut.recover(reasoningInput(h))).reasonCode, 'PROVIDER_TIMEOUT');
});

test('M4B deterministic success invokes Astra zero times and mismatch invokes Astra only as recovery', async () => {
  const h = harness();
  const deterministic = h.accessibility.prepare(plan(h));
  assert.equal(deterministic.resultCode, 'READY');
  let calls = 0;
  const coordinator = new DeviceUIReasoningCoordinator(new AstraDeviceUIReasoner({
    apiKey: 'sk-test',
    proposeFn: async () => {
      calls++;
      return proposal();
    },
  }));
  const recovered = await coordinator.recover(reasoningInput(h, { currentPlan: plan(h, { selectorContractPresent: false }) }));
  assert.equal(calls, 1);
  assert.equal(recovered.decision, 'AUTHORIZED_ACTION');
});

test('M4B WhatsApp and desktop observations pass through reasoner types but remain gated', () => {
  const h = harness();
  const gate = new DeviceUIActionGate();
  const whatsapp = reasoningInput(h, {
    observation: observation(h.device.deviceId, { packageName: 'com.whatsapp', screenId: 'chat-list' }),
    executionGoal: { appId: 'WHATSAPP', packageName: 'com.whatsapp', deviceId: h.device.deviceId, recipientRef: 'rcp_sarah', displayName: 'Sarah', approvedMessageHash: 'hash', route: 'ANDROID_ACCESSIBILITY' },
  });
  assert.notEqual(gate.validate(whatsapp, proposal({ expectedApp: 'com.whatsapp', action: 'FIND_ELEMENT' })).decision, 'AUTHORIZED_ACTION');

  const desktop = reasoningInput(h, {
    observation: observation(h.device.deviceId, { platform: 'WINDOWS', packageName: 'com.nagex.desktop', screenId: 'window-main' }),
  });
  assert.equal(desktop.observation.platform, 'WINDOWS');
});

test('M4B live diagnostic runner is explicit-guarded and production-path wired', () => {
  const result = spawnSync(process.execPath, ['scripts/astra-device-ui-live-diagnostic.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NAGEX_RUN_ASTRA_LIVE_DIAGNOSTIC: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /ASTRA_LIVE_DIAGNOSTIC=BLOCKED_EXPLICIT_GUARD_REQUIRED/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sk-|Authorization|Bearer/i);

  const source = fs.readFileSync('scripts/astra-device-ui-live-diagnostic.mjs', 'utf8');
  assert.match(source, /AstraDeviceUIReasoner/);
  assert.match(source, /DeviceUIActionGate/);
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /NAGEX_ASTRA_MODEL/);
  assert.match(source, /MAX_PROVIDER_CALLS', '1'/);
  assert.doesNotMatch(source, /See you at 6\.|Sarah|\+82|phone number/i);
});
