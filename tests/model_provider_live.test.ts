// R7 §12/§13 — real, non-mocked provider calls. These hit the actual
// OpenAI/Gemini/Nebius APIs over the network and therefore only run when
// this process's real environment already has real credentials (the exact
// same OPENAI_API_KEY/NAGEX_OPENAI_MODEL/GEMINI_API_KEY/NAGEX_GEMINI_MODEL/
// NEBIUS_API_KEY/NAGEX_NEBIUS_MODEL names providers.ts's createProviders()
// already reads — no new env var names invented here). Per the directive's
// own instruction, a missing credential is an explicit SKIP, never a
// silently-passing mock standing in for a real result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY && process.env.NAGEX_OPENAI_MODEL);
const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.NAGEX_GEMINI_MODEL);
const hasNebius = Boolean(process.env.NEBIUS_API_KEY && process.env.NAGEX_NEBIUS_MODEL);
const hasAnyRealProvider = hasOpenAI || hasGemini || hasNebius;

test(
  'LIVE: at least one configured provider returns a real, non-empty response for a trivial prompt',
  { skip: !hasAnyRealProvider ? 'no real provider credentials in this environment (OPENAI_API_KEY/GEMINI_API_KEY/NEBIUS_API_KEY not set) — see R7 §12/§13' : false },
  async () => {
    const providers = createProviders();
    const router = new UnifiedModelRouter(providers);
    const result = await router.generate({
      mode: 'auto',
      messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }],
    });
    assert.ok(result.text.trim().length > 0, 'a real provider must return real, non-empty text');
    assert.ok(['openai', 'gemini', 'nebius'].includes(result.provider));
    assert.equal(typeof result.latencyMs, 'number');
    assert.ok(result.latencyMs >= 0);
  },
);

test(
  'LIVE: after a real successful call, status() reports LIVE (not just CONFIGURED) for that provider',
  { skip: !hasAnyRealProvider ? 'no real provider credentials in this environment — see R7 §12/§13' : false },
  async () => {
    const providers = createProviders();
    const router = new UnifiedModelRouter(providers);
    const result = await router.generate({
      mode: 'auto',
      messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }],
    });
    const status = router.statuses().find((s) => s.provider === result.provider);
    assert.ok(status);
    assert.equal(status!.status, 'LIVE');
    assert.equal(status!.available, true);
    assert.ok(status!.lastCheckedAt);
  },
);
