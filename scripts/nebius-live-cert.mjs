#!/usr/bin/env node
// Opt-in REAL certification of the Nebius Token Factory / NVIDIA Nemotron runtime path. Makes exactly ONE paid call.
//
//   Set NEBIUS_API_KEY in the environment, then run:
//   NAGEX_LIVE_NEBIUS_CERT=1 node scripts/nebius-live-cert.mjs        (after `npm run build`)
//
// Not part of `npm test`: the normal suite never calls the paid API. The credential is read from the environment only and is
// never printed; the output is limited to the provider, model, latency, token counts and a PASS/FAIL line. Errors are reduced
// to their fixed reason code (never a provider message, header or payload).
import { createProviders } from '../dist/src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../dist/src/model-gateway/unified-model-router.js';

if (process.env.NAGEX_LIVE_NEBIUS_CERT !== '1') {
  console.log('REAL_NEBIUS_CALL=NOT_RUN (set NAGEX_LIVE_NEBIUS_CERT=1 to make one real, paid call)');
  process.exit(0);
}
if (!process.env.NEBIUS_API_KEY || !process.env.NEBIUS_API_KEY.trim()) {
  console.log('REAL_NEBIUS_CALL=NOT_RUN (NEBIUS_API_KEY is not set)');
  process.exit(0);
}

const EXPECTED = 'NAGEX_NEMOTRON_RUNTIME_OK';
// Only the Nebius provider is registered: this certifies the Nebius path itself, with no fallback able to mask a failure.
const nebius = createProviders(process.env).filter((p) => p.name === 'nebius');
const router = new UnifiedModelRouter(nebius, { info: () => {}, warn: () => {} });
try {
  const result = await router.generate({
    messages: [{ role: 'user', content: `Reply with exactly:\n${EXPECTED}` }],
    mode: 'auto',
    fallbackPolicy: 'DISALLOW',
    maxOutputTokens: 4096,                                   // room for reasoning tokens
    routingContext: { taskKind: 'PLAN', requiresJson: false, requestId: `live_cert_${Date.now()}` },
  });
  const pass = result.text.trim() === EXPECTED;
  console.log(`REAL_NEBIUS_CALL=${pass ? 'PASS' : 'FAIL'}`);
  console.log(`provider=${result.provider}`);
  console.log(`model=${result.model}`);
  console.log(`latencyMs=${result.latencyMs}`);
  console.log(`inputTokens=${result.usage?.inputTokens ?? 'n/a'} outputTokens=${result.usage?.outputTokens ?? 'n/a'} totalTokens=${result.usage?.totalTokens ?? 'n/a'} reasoningTokens=${result.usage?.reasoningTokens ?? 'n/a'}`);
  console.log(`reasoningAvailable=${result.meta?.reasoningAvailable ?? false} finishReason=${result.meta?.finishReason ?? 'n/a'}`);
  if (!pass) console.log('note=the answer did not match the expected text exactly');
  process.exit(pass ? 0 : 1);
} catch (error) {
  const failures = Array.isArray(error?.details?.failures) ? error.details.failures.map((f) => `${f.provider}:${f.reason}`).join(',') : 'n/a';
  console.log('REAL_NEBIUS_CALL=FAIL');
  console.log(`code=${typeof error?.code === 'string' ? error.code : 'UNKNOWN'} reasons=${failures}`);
  process.exit(1);
}
