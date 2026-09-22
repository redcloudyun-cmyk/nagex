// R22.S P1 — Canonical Model Provider Test Fixtures.
//
// ModelRoutingPolicy.satisfiesCapabilities() fails closed when a provider
// declares no `capabilities` at all ("unknown capability != supported
// capability", never fail-open — see src/model-gateway/model-routing-policy.ts).
// Before R22.5 this went unenforced, so dozens of test files across the
// suite hand-rolled a fake ModelProvider object literal without a
// `capabilities` field; every one of them now fails closed with
// NO_MODEL_PROVIDER_CONFIGURED ("No model provider satisfies required
// capabilities"), not because the product regressed but because the fixture
// was always silently relying on a fail-open bug.
//
// These helpers are the canonical replacement: every fake provider must
// truthfully declare the ModelProviderCapabilities contract for the role it
// actually plays in its test, never blindly copy-pasted. Two shapes cover
// the whole suite:
//   - "structured": plan / understand / meetingPrep / daily brief /
//     structured extraction / JSON-returning execution planning.
//   - "general chat": OpenAI-style/general-chat-only behavior, intentionally
//     unable to satisfy JSON-mode or structured-extraction requirements
//     (this must stay false-false to match OpenAIProvider's own real,
//     canonical capability declaration in src/model-gateway/providers.ts —
//     never "fixed" to true just to make a test pass).
import type { ModelProvider, ModelRequest, ModelResponse, ProviderStatus } from '../src/model-gateway/model-provider.js';
import type { ModelProviderCapabilities } from '../src/model-gateway/model-routing.types.js';

export interface FixtureProviderOptions {
  name?: string;
  model?: string;
}

function structuredCapabilities(provider: string): ModelProviderCapabilities {
  return { provider, supportsJsonMode: true, supportsGeneralChat: true, supportsStructuredExtraction: true };
}

function generalChatOnlyCapabilities(provider: string): ModelProviderCapabilities {
  return { provider, supportsJsonMode: false, supportsGeneralChat: true, supportsStructuredExtraction: false };
}

function baseStatus(provider: string, model: string): ProviderStatus {
  return { configured: true, available: true, provider, model, status: 'LIVE', lastCheckedAt: null, degradedReason: null };
}

function replyToResponse(name: string, model: string, request: ModelRequest, result: string | Error): ModelResponse {
  if (result instanceof Error) throw result;
  return { text: result, provider: name, model, latencyMs: 1, requestId: request.requestId };
}

// plan / understand / meetingPrep / daily brief / structured extraction /
// JSON-returning execution planning.
export function createStructuredModelProvider(reply: () => string | Error, opts: FixtureProviderOptions = {}): ModelProvider {
  const name = opts.name ?? 'nebius';
  const model = opts.model ?? 'test-model';
  return {
    name,
    model,
    capabilities: structuredCapabilities(name),
    status: () => baseStatus(name, model),
    generate: async (request: ModelRequest): Promise<ModelResponse> => replyToResponse(name, model, request, reply()),
  };
}

// Deliberately OpenAI-style / general-chat-only — never satisfies
// requiresJson or STRUCTURED_EXTRACTION/CHAT-only-general routing checks
// that need JSON. Use this only where the test's intent is specifically to
// exercise general-chat-only behavior.
export function createGeneralChatModelProvider(reply: () => string | Error, opts: FixtureProviderOptions = {}): ModelProvider {
  const name = opts.name ?? 'openai';
  const model = opts.model ?? 'test-model';
  return {
    name,
    model,
    capabilities: generalChatOnlyCapabilities(name),
    status: () => baseStatus(name, model),
    generate: async (request: ModelRequest): Promise<ModelResponse> => replyToResponse(name, model, request, reply()),
  };
}

// A structured-capable provider whose generate() always throws — for tests
// that assert real failure handling (ALL_MODEL_PROVIDERS_FAILED etc.)
// without wanting to hand-write the ModelProvider shape each time.
export function createFailingStructuredProvider(error: Error, opts: FixtureProviderOptions = {}): ModelProvider {
  return createStructuredModelProvider(() => error, opts);
}

// A structured-capable provider whose generate() stays pending until the
// caller explicitly resolves it — for tests that must observe genuine
// mid-flight state (e.g. a task's status while its model call is still in
// progress) rather than assuming a synchronous/instant completion.
export function createDeferredStructuredProvider(opts: FixtureProviderOptions = {}): { provider: ModelProvider; resolve: (text: string) => void } {
  const name = opts.name ?? 'nebius';
  const model = opts.model ?? 'test-model';
  let resolveFn!: (text: string) => void;
  const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });
  const provider: ModelProvider = {
    name,
    model,
    capabilities: structuredCapabilities(name),
    status: () => baseStatus(name, model),
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const text = await deferred;
      return { text, provider: name, model, latencyMs: 1, requestId: request.requestId };
    },
  };
  return { provider, resolve: resolveFn! };
}
