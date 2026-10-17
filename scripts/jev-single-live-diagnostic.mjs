import { JEV_SHADOW_FIXTURES } from '../dist/src/model-gateway/jev-shadow-fixtures.js';
import { JevSystemOneProvider, buildJevRequestBody } from '../dist/src/model-gateway/jev-provider.js';
import { resolveJevApiKey } from '../dist/src/model-gateway/jev-config.js';
import { jevIdempotencyKey, newJevRunId } from '../dist/src/model-gateway/jev-idempotency.js';
import { loadJevEnv } from './_jev-env.mjs';
import { failureLines } from './_jev-report.mjs';

const FIXTURE_ID = 'chat-simple-001';

function fixtureState(fixture) {
  return {
    fixtureId: fixture.id,
    taskKind: fixture.taskKind,
    requiresJson: fixture.requiresJson,
    requiresEvidenceGrounding: Boolean(fixture.requiresEvidenceGrounding),
    syntheticScenario: `Synthetic ${fixture.taskKind} fixture ${fixture.id}. No real user data.`,
  };
}

const fixture = JEV_SHADOW_FIXTURES.find((entry) => entry.id === FIXTURE_ID);
if (!fixture) throw new Error(`Missing fixture: ${FIXTURE_ID}`);

// OPT-IN: this makes a real request to a service that may be billable. Without NAGEX_LIVE_JEV=1 nothing is sent, whether or not a key exists.
if (process.env.NAGEX_LIVE_JEV !== '1') {
  console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=NOT_RUN');
  console.log('HINT=Set NAGEX_LIVE_JEV=1 to make ONE real request.');
  process.exit(0);
}
// the key under either historical name (NAGEX_JEV_API_KEY / JEVMODEL_API_KEY), from this process, a service pid or --jev-env-file
const apiKey = resolveJevApiKey(loadJevEnv().env).key ?? undefined;
if (!apiKey) {
  console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=FAIL');
  console.log('HTTP_STATUS=NOT_RUN');
  console.log('JEV_ERROR_RESPONSE=UNAVAILABLE_NO_KEY');
  console.log('INVALID_FIELD=UNKNOWN');
  process.exitCode = 2;
} else {
  const provider = new JevSystemOneProvider({ apiKey, timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 10_000) });
  // The Idempotency-Key names THIS request in THIS run: derived from the run's own id and the exact body sent - never a fixed string per fixture, which collides as soon as the request changes between runs.
  const runId = newJevRunId();
  const input = {
    fixtureId: fixture.id,
    state: fixtureState(fixture),
    taskKind: fixture.taskKind,
    requiresJson: fixture.requiresJson,
    requiresEvidenceGrounding: fixture.requiresEvidenceGrounding,
    signals: fixture.signals,
  };
  const idempotencyKey = jevIdempotencyKey(runId, 'diagnostic', buildJevRequestBody(input));
  console.log(`IDEMPOTENCY_RUN_ID=${runId}`);
  try {
    const out = await provider.evaluate({ ...input, idempotencyKey });
    console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=PASS');
    console.log('HTTP_STATUS=200');
    console.log(`RESOLVED_JEV_MODEL=${out.resolvedModel}`);
    console.log(`COMPLEXITY=${out.complexity}`);
    console.log(`COMPLEXITY_CONFIDENCE=${out.complexityConfidence}`);
    console.log(`HIGH_RISK=${out.highRiskProbability}`);
    console.log(`REASONING_LEVEL=${out.reasoningLevel}`);
    console.log(`LATENCY_MS=${out.latencyMs}`);
  } catch (error) {
    console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=FAIL');
    for (const line of failureLines(error, apiKey)) console.log(line);
    process.exitCode = 1;
  }
}
