// R22.5/R22.6 — Model Provider Capability Contract Regression Tests.
//
// Locks down the authoritative capability metadata for each provider and
// verifies that ModelRoutingPolicy enforces the correct routing decisions:
//
//   OpenAI:  supportsJsonMode=false, supportsStructuredExtraction=false
//            → ineligible for STRUCTURED_EXTRACTION / jsonMode=true tasks
//            → eligible for CHAT tasks
//
//   Nebius / Gemini: supportsJsonMode=true, supportsStructuredExtraction=true
//            → eligible for all task kinds including STRUCTURED_EXTRACTION
//
// ROUTING POLICY INVARIANTS (never relaxed here):
//   - No fail-open: a provider without capabilities → ineligible
//   - OpenAI intentionally does NOT support STRUCTURED_EXTRACTION
//   - Mocked providers must declare capabilities to pass routing

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, GeminiProvider, NebiusProvider } from '../src/model-gateway/providers.js';
import { ModelRoutingPolicy } from '../src/model-gateway/model-routing-policy.js';
import type { ModelRoutingContext } from '../src/model-gateway/model-routing.types.js';

// ── 1. Provider Capability Metadata ─────────────────────────────────────────

test('OpenAI: supportsJsonMode=false (intentional)', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  assert.equal(provider.capabilities.supportsJsonMode, false,
    'OpenAI must NOT declare supportsJsonMode=true');
});

test('OpenAI: supportsStructuredExtraction=false (intentional)', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  assert.equal(provider.capabilities.supportsStructuredExtraction, false,
    'OpenAI must NOT declare supportsStructuredExtraction=true');
});

test('OpenAI: supportsGeneralChat=true (eligible for CHAT tasks)', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  assert.equal(provider.capabilities.supportsGeneralChat, true);
});

test('Nebius: full capability set — eligible for STRUCTURED_EXTRACTION/CHAT/JSON', () => {
  const provider = new NebiusProvider({ apiKey: 'test', model: 'test' });
  assert.equal(provider.capabilities.supportsJsonMode, true);
  assert.equal(provider.capabilities.supportsStructuredExtraction, true);
  assert.equal(provider.capabilities.supportsGeneralChat, true);
});

test('Gemini: full capability set — eligible for STRUCTURED_EXTRACTION/CHAT/JSON', () => {
  const provider = new GeminiProvider({ apiKey: 'test', model: 'test' });
  assert.equal(provider.capabilities.supportsJsonMode, true);
  assert.equal(provider.capabilities.supportsStructuredExtraction, true);
  assert.equal(provider.capabilities.supportsGeneralChat, true);
});

// ── 2. Routing Policy: STRUCTURED_EXTRACTION ─────────────────────────────────

const policy = new ModelRoutingPolicy();

const structuredContext: ModelRoutingContext = {
  taskKind: 'STRUCTURED_EXTRACTION',
  requiresJson: true,
  requestId: 'req_cap_test',
};

const chatContext: ModelRoutingContext = {
  taskKind: 'CHAT',
  requiresJson: false,
  requestId: 'req_cap_test',
};

test('Routing policy: OpenAI is NOT eligible for STRUCTURED_EXTRACTION', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  assert.equal(
    policy.satisfiesCapabilities(provider, structuredContext),
    false,
    'OpenAI must be ineligible for STRUCTURED_EXTRACTION — routing policy must not fail-open',
  );
});

test('Routing policy: OpenAI is NOT eligible for jsonMode=true tasks', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  const jsonContext: ModelRoutingContext = { taskKind: 'CHAT', requiresJson: true, requestId: 'req_cap_test' };
  assert.equal(
    policy.satisfiesCapabilities(provider, jsonContext),
    false,
  );
});

test('Routing policy: OpenAI IS eligible for plain CHAT tasks', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  assert.equal(
    policy.satisfiesCapabilities(provider, chatContext),
    true,
  );
});

test('Routing policy: Nebius IS eligible for STRUCTURED_EXTRACTION', () => {
  const provider = new NebiusProvider({ apiKey: 'test', model: 'test' });
  assert.equal(
    policy.satisfiesCapabilities(provider, structuredContext),
    true,
  );
});

test('Routing policy: Gemini IS eligible for STRUCTURED_EXTRACTION', () => {
  const provider = new GeminiProvider({ apiKey: 'test', model: 'test' });
  assert.equal(
    policy.satisfiesCapabilities(provider, structuredContext),
    true,
  );
});

// ── 3. No Fail-Open: provider with undefined capabilities is ineligible ───────

test('Routing policy: provider with undefined capabilities is ineligible (no fail-open)', () => {
  const noCapProvider = {
    name: 'no-cap',
    model: null,
    capabilities: undefined,
    status: () => ({ configured: true, available: true, provider: 'no-cap', model: null, status: 'CONFIGURED' as const, lastCheckedAt: null, degradedReason: null }),
    generate: async () => { throw new Error('not called'); },
  };
  assert.equal(
    policy.satisfiesCapabilities(noCapProvider as any, structuredContext),
    false,
    'A provider missing capabilities must never be considered eligible — no fail-open',
  );
});

// ── 4. getEligibleProviders returns only Nebius/Gemini for STRUCTURED tasks ──

test('getEligibleProviders: with OpenAI+Nebius configured, only Nebius eligible for STRUCTURED_EXTRACTION', () => {
  const openai = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  const nebius = new NebiusProvider({ apiKey: 'test', model: 'test' });
  const eligible = policy.getEligibleProviders(structuredContext, [openai, nebius]);
  assert.equal(eligible.some((p) => p.name === 'openai'), false,
    'OpenAI must not appear in eligible set for STRUCTURED_EXTRACTION');
  assert.equal(eligible.some((p) => p.name === 'nebius'), true);
});

test('getEligibleProviders: with OpenAI+Nebius configured, both eligible for CHAT', () => {
  const openai = new OpenAIProvider({ apiKey: 'test', model: 'test' });
  const nebius = new NebiusProvider({ apiKey: 'test', model: 'test' });
  const eligible = policy.getEligibleProviders(chatContext, [openai, nebius]);
  assert.equal(eligible.some((p) => p.name === 'openai'), true);
  assert.equal(eligible.some((p) => p.name === 'nebius'), true);
});
