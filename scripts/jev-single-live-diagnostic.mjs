import { JEV_SHADOW_FIXTURES } from '../dist/src/model-gateway/jev-shadow-fixtures.js';
import { JevSystemOneProvider } from '../dist/src/model-gateway/jev-provider.js';

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

function reportFailure(error) {
  console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=FAIL');
  const status = typeof error?.code === 'string' && error.code.startsWith('PROVIDER_HTTP_')
    ? error.code.replace('PROVIDER_HTTP_', '')
    : error?.code ?? 'UNKNOWN';
  console.log(`HTTP_STATUS=${status}`);
  if (error?.details?.responseBody) {
    console.log(`JEV_422_RESPONSE=${String(error.details.responseBody).replace(/\r?\n/g, ' ')}`);
  } else {
    console.log('JEV_422_RESPONSE=UNAVAILABLE');
  }
  const body = String(error?.details?.responseBody ?? '');
  const invalidField = ['instructions', 'input', 'fixtureId', 'signals', 'idempotencyKey', 'metadata', 'taskKind'].find((field) => body.includes(field));
  console.log(`INVALID_FIELD=${invalidField ?? 'UNKNOWN'}`);
}

const fixture = JEV_SHADOW_FIXTURES.find((entry) => entry.id === FIXTURE_ID);
if (!fixture) throw new Error(`Missing fixture: ${FIXTURE_ID}`);

const apiKey = process.env.JEVMODEL_API_KEY;
if (!apiKey) {
  console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=FAIL');
  console.log('HTTP_STATUS=NOT_RUN');
  console.log('JEV_422_RESPONSE=UNAVAILABLE_NO_KEY');
  console.log('INVALID_FIELD=UNKNOWN');
  process.exitCode = 2;
} else {
  const provider = new JevSystemOneProvider({ apiKey, timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 10_000) });
  try {
    const out = await provider.evaluate({
      fixtureId: fixture.id,
      state: fixtureState(fixture),
      taskKind: fixture.taskKind,
      requiresJson: fixture.requiresJson,
      requiresEvidenceGrounding: fixture.requiresEvidenceGrounding,
      signals: fixture.signals,
      idempotencyKey: `nagex-jev-diagnostic-${fixture.id}`,
    });
    console.log('JEV_SINGLE_LIVE_DIAGNOSTIC=PASS');
    console.log('HTTP_STATUS=200');
    console.log(`RESOLVED_JEV_MODEL=${out.resolvedModel}`);
    console.log(`COMPLEXITY=${out.complexity}`);
    console.log(`COMPLEXITY_CONFIDENCE=${out.complexityConfidence}`);
    console.log(`HIGH_RISK=${out.highRiskProbability}`);
    console.log(`REASONING_LEVEL=${out.reasoningLevel}`);
    console.log(`LATENCY_MS=${out.latencyMs}`);
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  }
}
