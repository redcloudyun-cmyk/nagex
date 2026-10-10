#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIVE_GUARD_ENV = 'NAGEX_RUN_ASTRA_LIVE_DIAGNOSTIC';
const MODEL_ENV_NAME = 'NAGEX_ASTRA_MODEL';
const API_KEY_ENV_NAME = 'OPENAI_API_KEY';
const DEFAULT_ASTRA_MODEL = 'gpt-6-astra';

function printMarker(name, value) {
  process.stdout.write(`${name}=${value}\n`);
}

function fail(reason, exitCode = 1) {
  printMarker('ASTRA_LIVE_SYNTHETIC_DIAGNOSTIC', 'FAIL');
  printMarker('FAIL_REASON', reason);
  process.exit(exitCode);
}

if (process.env[LIVE_GUARD_ENV] !== 'YES') {
  printMarker('ASTRA_LIVE_DIAGNOSTIC', 'BLOCKED_EXPLICIT_GUARD_REQUIRED');
  process.exit(1);
}

const apiKeyPresent = Boolean(process.env[API_KEY_ENV_NAME]?.trim());
const model = process.env[MODEL_ENV_NAME]?.trim() || DEFAULT_ASTRA_MODEL;

printMarker('OPENAI_API_KEY_PRESENT', apiKeyPresent ? 'YES' : 'NO');
printMarker('ASTRA_MODEL_RESOLVED', model);
printMarker('MAX_PROVIDER_CALLS', '1');

if (!apiKeyPresent) {
  fail('OPENAI_API_KEY_MISSING');
}

let providerCalls = 0;

try {
  const reasonerModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'execution', 'device-ui-reasoner.js')).href);
  const approvalModule = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'governance', 'action-approval.store.js')).href);

  const {
    AstraDeviceUIReasoner,
    DeviceUIActionGate,
    approvedMessageHash,
    isDeviceUIActionProposal,
  } = reasonerModule;
  const { hashCanonicalPayload } = approvalModule;

  const requestId = `m4b-r2-live-${Date.now()}`;
  const deviceId = 'synthetic-device-m4b-r2';
  const recipientRef = 'synthetic-recipient';
  const displayName = 'Synthetic Recipient';
  const approvedMessage = 'Synthetic approved message.';
  const packageName = 'com.kakao.talk';
  const route = 'ANDROID_ACCESSIBILITY';
  const materialPayloadHash = hashCanonicalPayload({
    appId: 'KAKAOTALK',
    packageName,
    recipientRef,
    displayName,
    messageHash: approvedMessageHash(approvedMessage),
    deviceId,
    executionRoute: route,
  });

  const input = {
    requestId,
    providerPreference: ['DETERMINISTIC', 'ASTRA'],
    observation: {
      platform: 'ANDROID',
      deviceRef: deviceId,
      packageName,
      appVersion: 'synthetic-certified-range',
      screenId: 'chat-list',
      foregroundState: 'FOREGROUND',
      nodes: [
        { nodeRef: 'node_search', resourceId: 'synthetic_search', role: 'Button', contentDescription: 'Search', clickable: true, editable: false, enabled: true },
        { nodeRef: 'node_chat_list', resourceId: 'synthetic_chat_list', role: 'List', contentDescription: 'Chat list', clickable: false, editable: false, enabled: true },
        { nodeRef: 'node_new_chat', resourceId: 'synthetic_new_chat', role: 'Button', contentDescription: 'New chat', clickable: true, editable: false, enabled: true },
      ],
      availableSemanticActions: ['FIND_ELEMENT', 'WAIT', 'OBSERVE_RESULT'],
      executionStep: 'CHAT_LIST_OBSERVED',
      timestamp: new Date().toISOString(),
      screenshotAllowed: false,
    },
    executionGoal: {
      appId: 'KAKAOTALK',
      packageName,
      deviceId,
      recipientRef,
      displayName,
      approvedMessageHash: approvedMessageHash(approvedMessage),
      route,
      approvalId: 'synthetic-approval-m4b-r2',
    },
    allowedActions: ['FIND_ELEMENT', 'WAIT', 'OBSERVE_RESULT'],
    currentPlan: {
      tenantId: 'synthetic-tenant',
      principalId: 'synthetic-principal',
      deviceId,
      requestId,
      appId: 'KAKAOTALK',
      packageName,
      detectedVersion: 'synthetic-certified-range',
      actions: ['OPEN_APP', 'SEARCH_CONTACT', 'OBSERVE_RESULT'],
      recipientRef,
      displayName,
      approvedMessage,
      typedMessage: approvedMessage,
      observedRecipientName: displayName,
      recipientCandidateCount: 1,
      selectorContractPresent: true,
      approval: {
        status: 'APPROVED',
        canonicalPayload: {
          capability: 'KAKAOTALK_ACCESSIBILITY_SEND',
          recipientRef,
          provider: 'KAKAOTALK',
          environment: 'ANDROID',
          executionRoute: route,
          materialPayloadHash,
        },
      },
    },
    budget: {
      maxSteps: 10,
      maxClicks: 5,
      maxTextInputs: 1,
      maxScrolls: 2,
      maxReasonerCalls: 1,
      deadlineMs: 30_000,
      usedSteps: 0,
      usedClicks: 0,
      usedTextInputs: 0,
      usedScrolls: 0,
      usedReasonerCalls: 0,
      startedAtMs: Date.now(),
    },
  };

  const astra = new AstraDeviceUIReasoner({
    apiKey: process.env[API_KEY_ENV_NAME],
    model,
    fetchFn: async (...args) => {
      providerCalls++;
      if (providerCalls > 1) {
        throw new Error('MAX_PROVIDER_CALLS_EXCEEDED');
      }
      return fetch(...args);
    },
  });

  const proposal = await astra.reason(input);
  const typed = isDeviceUIActionProposal(proposal);
  const gateResult = new DeviceUIActionGate().validate(input, proposal);
  const usage = astra.usage();

  printMarker('ASTRA_CALLS', String(providerCalls));
  printMarker('REAL_ASTRA_PROVIDER_CALL', providerCalls === 1 ? 'PASS' : 'FAIL');
  printMarker('ASTRA_TYPED_PROPOSAL', typed ? 'PASS' : 'FAIL');
  printMarker('ACTION_GATE_AFTER_ASTRA', gateResult ? 'PASS' : 'FAIL');
  printMarker('PROPOSED_ACTION', typed ? proposal.action : 'INVALID');
  printMarker('ACTION_GATE_RESULT', gateResult?.decision ?? 'UNAVAILABLE');
  printMarker('ASTRA_INPUT_TOKENS', usage?.inputTokens ?? 'UNAVAILABLE');
  printMarker('ASTRA_OUTPUT_TOKENS', usage?.outputTokens ?? 'UNAVAILABLE');
  printMarker('ASTRA_LATENCY_MS', usage?.latencyMs ?? 'UNAVAILABLE');
  printMarker('ASTRA_ESTIMATED_COST', 'NOT_CALCULATED');

  if (providerCalls !== 1) fail('PROVIDER_CALL_COUNT_NOT_ONE');
  if (!typed) fail('REASONER_OUTPUT_INVALID');
  if (!gateResult) fail('ACTION_GATE_UNAVAILABLE');

  printMarker('ASTRA_LIVE_SYNTHETIC_DIAGNOSTIC', 'PASS');
  process.exit(0);
} catch (error) {
  printMarker('ASTRA_CALLS', String(providerCalls));
  printMarker('REAL_ASTRA_PROVIDER_CALL', providerCalls === 1 ? 'FAIL' : 'NOT_COMPLETED');
  printMarker('ASTRA_TYPED_PROPOSAL', 'FAIL');
  printMarker('ACTION_GATE_AFTER_ASTRA', 'FAIL');
  printMarker('ERROR_CODE', error && typeof error === 'object' && 'code' in error ? error.code : 'DIAGNOSTIC_FAILED');
  fail('ASTRA_LIVE_DIAGNOSTIC_FAILED');
}
