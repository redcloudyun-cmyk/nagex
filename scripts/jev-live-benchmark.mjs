import { JEV_SHADOW_FIXTURES } from '../dist/src/model-gateway/jev-shadow-fixtures.js';
import { JevSystemOneProvider } from '../dist/src/model-gateway/jev-provider.js';
import { buildJevLiveResultRecord, persistJevLiveBenchmarkArtifacts } from '../dist/src/model-gateway/jev-live-results.js';
import { ModelRoutingPolicy } from '../dist/src/model-gateway/model-routing-policy.js';

const SELECTED_FIXTURE_IDS = [
  'chat-simple-001',
  'chat-simple-002',
  'chat-simple-003',
  'chat-ambiguous-001',
  'chat-ambiguous-002',
  'chat-ambiguous-003',
  'plan-light-001',
  'plan-light-002',
  'plan-multistep-001',
  'plan-long-001',
  'high-risk-001',
  'high-risk-002',
  'research-001',
  'research-002',
  'research-003',
  'research-004',
  'research-005',
  'research-006',
  'meeting-001',
  'meeting-002',
  'meeting-003',
  'meeting-004',
  'meeting-005',
  'meeting-006',
  'extract-001',
  'extract-002',
  'extract-003',
  'extract-ambiguous-001',
  'extract-ambiguous-002',
  'extract-ambiguous-003',
  'brief-001',
  'brief-002',
  'brief-003',
  'brief-004',
  'brief-005',
  'brief-006',
];

class BenchmarkProvider {
  constructor(name, model, eligibleTaskKinds) {
    this.name = name;
    this.model = model;
    this.capabilities = {
      provider: name,
      supportsJsonMode: name !== 'openai',
      supportsGeneralChat: name !== 'nebius' || Boolean(eligibleTaskKinds),
      supportsStructuredExtraction: name !== 'nebius',
      ...(eligibleTaskKinds ? { eligibleTaskKinds } : {}),
    };
  }
  status() {
    return {
      configured: true,
      available: true,
      provider: this.name,
      model: this.model,
      status: 'CONFIGURED',
      lastCheckedAt: null,
      degradedReason: null,
    };
  }
  async generate() {
    throw new Error('BenchmarkProvider never calls providers.');
  }
}

function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function percentile(values, pctValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pctValue / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function median(values) {
  return percentile(values, 50);
}

function baselineNemotron(fixture) {
  const providers = [
    new BenchmarkProvider('nebius', 'nvidia/Nemotron-3_5-Lightning', ['PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP']),
    new BenchmarkProvider('gemini', 'gemini-benchmark'),
    new BenchmarkProvider('openai', 'gpt-benchmark'),
  ];
  const decision = new ModelRoutingPolicy().select(
    'auto',
    {
      taskKind: fixture.taskKind,
      requiresJson: fixture.requiresJson,
      requiresEvidenceGrounding: fixture.requiresEvidenceGrounding,
      requestId: fixture.id,
    },
    providers,
    providers.map((provider) => provider.name)
  );
  return decision.selectedProvider === 'nebius';
}

function classifyMismatch(fixture, out) {
  const goldHigh = fixture.expectedComplexity === 'HIGH_REASONING' || fixture.expectedRiskClass === 'HIGH';
  const jevHigh = out.complexity === 'HIGH_REASONING' || (out.highRiskProbability ?? 0) >= 0.7;
  if (goldHigh && !jevHigh) return 'FALSE_DOWNGRADE';
  if (!goldHigh && fixture.expectedComplexity !== 'UNCERTAIN' && jevHigh) return 'FALSE_UPGRADE';
  return 'OTHER';
}

function fixtureState(fixture) {
  return {
    fixtureId: fixture.id,
    taskKind: fixture.taskKind,
    requiresJson: fixture.requiresJson,
    requiresEvidenceGrounding: Boolean(fixture.requiresEvidenceGrounding),
    syntheticScenario: `Synthetic ${fixture.taskKind} fixture ${fixture.id}. No real user data.`,
  };
}

async function main() {
  if (process.env.JEV_RUN_36 !== 'YES') {
    console.log('JEV_LIVE_SAMPLE=FAIL');
    console.log('FAILURE_REASON=JEV_RUN_36_NOT_ENABLED');
    console.log('HINT=Set JEV_RUN_36=YES only after the single-fixture diagnostic passes.');
    process.exitCode = 2;
    return;
  }
  if (SELECTED_FIXTURE_IDS.length > 36 && process.env.JEV_RUN_FULL !== 'YES') {
    console.log('JEV_LIVE_SAMPLE=FAIL');
    console.log('FAILURE_REASON=JEV_RUN_FULL_NOT_ENABLED');
    console.log('HINT=Set JEV_RUN_FULL=YES only for an explicitly approved full live benchmark.');
    process.exitCode = 2;
    return;
  }
  console.log(`SELECTED_FIXTURE_IDS=${SELECTED_FIXTURE_IDS.join(',')}`);
  const apiKey = process.env.JEVMODEL_API_KEY;
  if (!apiKey) {
    console.log('JEV_LIVE_SAMPLE=FAIL');
    console.log('FAILURE_REASON=JEVMODEL_API_KEY_NOT_PRESENT');
    process.exitCode = 2;
    return;
  }

  const fixtureMap = new Map(JEV_SHADOW_FIXTURES.map((fixture) => [fixture.id, fixture]));
  const fixtures = SELECTED_FIXTURE_IDS.map((id) => fixtureMap.get(id));
  if (fixtures.some((fixture) => !fixture)) throw new Error('Selected fixture id is missing from JEV_SHADOW_FIXTURES.');

  const provider = new JevSystemOneProvider({ apiKey, timeoutMs: Number(process.env.JEV_TIMEOUT_MS || 10_000) });
  let attempts = 0;
  let successes = 0;
  let failures = 0;
  let correct = 0;
  let falseDowngrades = 0;
  let falseUpgrades = 0;
  let uncertain = 0;
  let baselineNemotronSelections = 0;
  let projectedNemotronAvoided = 0;
  const latencies = [];
  const harmlessRisk = [];
  const consequentialRisk = [];
  const resolvedModels = new Set();
  const disagreements = [];
  const records = [];

  for (const fixture of fixtures) {
    attempts++;
    try {
      const out = await provider.evaluate({
        fixtureId: fixture.id,
        state: fixtureState(fixture),
        taskKind: fixture.taskKind,
        requiresJson: fixture.requiresJson,
        requiresEvidenceGrounding: fixture.requiresEvidenceGrounding,
        signals: fixture.signals,
        idempotencyKey: `nagex-jev-live-${fixture.id}`,
      });
      successes++;
      latencies.push(out.latencyMs);
      resolvedModels.add(out.resolvedModel);
      if (out.complexity === 'UNCERTAIN') uncertain++;
      if (out.highRiskProbability !== null) {
        if (fixture.expectedRiskClass === 'HIGH') consequentialRisk.push(out.highRiskProbability);
        else harmlessRisk.push(out.highRiskProbability);
      }
      records.push(buildJevLiveResultRecord({
        fixtureId: fixture.id,
        taskKind: fixture.taskKind,
        goldComplexity: fixture.expectedComplexity,
        goldReasoningLevel: fixture.expectedReasoningLevel,
        jevComplexity: out.complexity,
        jevComplexityConfidence: out.complexityConfidence,
        jevReasoningLevel: out.reasoningLevel,
        highRiskProbability: out.highRiskProbability,
        resolvedModel: out.resolvedModel,
        latencyMs: out.latencyMs,
      }));
      const isCorrect = out.complexity === fixture.expectedComplexity
        && out.reasoningLevel === fixture.expectedReasoningLevel
        && ((out.highRiskProbability ?? 0) >= 0.7 ? 'HIGH' : 'LOW') === fixture.expectedRiskClass;
      if (isCorrect) correct++;
      else {
        const errorType = classifyMismatch(fixture, out);
        if (errorType === 'FALSE_DOWNGRADE') falseDowngrades++;
        if (errorType === 'FALSE_UPGRADE') falseUpgrades++;
        disagreements.push({
          FIXTURE_ID: fixture.id,
          TASK_KIND: fixture.taskKind,
          GOLD_COMPLEXITY: fixture.expectedComplexity,
          JEV_COMPLEXITY: out.complexity,
          CONFIDENCE: out.complexityConfidence,
          GOLD_REASONING_LEVEL: fixture.expectedReasoningLevel,
          JEV_REASONING_LEVEL: out.reasoningLevel,
          HIGH_RISK_PROBABILITY: out.highRiskProbability,
          ERROR_TYPE: errorType,
        });
      }
      if (baselineNemotron(fixture)) {
        baselineNemotronSelections++;
        if (out.complexity === 'SIMPLE' || out.complexity === 'STANDARD') projectedNemotronAvoided++;
      }
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ event: 'jev_live_fixture_failed', fixtureId: fixture.id, code: error?.code ?? 'UNKNOWN' }));
    }
  }

  const highGoldCount = fixtures.filter((fixture) => fixture.expectedComplexity === 'HIGH_REASONING' || fixture.expectedRiskClass === 'HIGH').length;
  const lowGoldCount = fixtures.filter((fixture) => fixture.expectedComplexity !== 'HIGH_REASONING' && fixture.expectedComplexity !== 'UNCERTAIN' && fixture.expectedRiskClass !== 'HIGH').length;
  const accuracy = successes === 0 ? 0 : correct / successes;
  const falseDowngradeRate = highGoldCount === 0 ? 0 : falseDowngrades / highGoldCount;
  const falseUpgradeRate = lowGoldCount === 0 ? 0 : falseUpgrades / lowGoldCount;
  const projectedReduction = baselineNemotronSelections === 0 ? 0 : projectedNemotronAvoided / baselineNemotronSelections;
  const passed = successes === fixtures.length && accuracy >= 0.95 && falseDowngradeRate <= 0.02;
  const summary = await persistJevLiveBenchmarkArtifacts({ records });

  console.log(`JEV_LIVE_SAMPLE=${passed ? 'PASS' : 'FAIL'}`);
  console.log(`LIVE_FIXTURE_COUNT=${fixtures.length}`);
  console.log(`RESOLVED_JEV_MODEL=${[...resolvedModels].join('|') || 'NONE'}`);
  console.log(`LIVE_CALL_ATTEMPTS=${attempts}`);
  console.log(`LIVE_CALL_SUCCESSES=${successes}`);
  console.log(`LIVE_CALL_FAILURES=${failures}`);
  console.log(`LIVE_JEV_ROUTING_ACCURACY=${pct(accuracy)}`);
  console.log(`COMPLEXITY_EXACT_ACCURACY=${pct(summary.complexityExactAccuracy)}`);
  console.log(`REASONING_LEVEL_EXACT_ACCURACY=${pct(summary.reasoningLevelExactAccuracy)}`);
  console.log(`JOINT_EXACT_ACCURACY=${pct(summary.jointExactAccuracy)}`);
  console.log(`ROUTING_DECISION_ACCURACY=${pct(summary.routingDecisionAccuracy)}`);
  console.log(`LIVE_FALSE_DOWNGRADE_COUNT=${falseDowngrades}`);
  console.log(`LIVE_FALSE_DOWNGRADE_RATE=${pct(falseDowngradeRate)}`);
  console.log(`LIVE_FALSE_UPGRADE_COUNT=${falseUpgrades}`);
  console.log(`LIVE_FALSE_UPGRADE_RATE=${pct(falseUpgradeRate)}`);
  console.log(`LIVE_UNCERTAIN_RATE=${pct(successes === 0 ? 0 : uncertain / successes)}`);
  console.log(`LIVE_P50_LATENCY_MS=${percentile(latencies, 50)}`);
  console.log(`LIVE_P95_LATENCY_MS=${percentile(latencies, 95)}`);
  console.log(`HARMLESS_HIGH_RISK_MEDIAN=${median(harmlessRisk)}`);
  console.log(`CONSEQUENTIAL_HIGH_RISK_MEDIAN=${median(consequentialRisk)}`);
  console.log(`PROJECTED_NEMOTRON_CALL_REDUCTION=${pct(projectedReduction)}`);
  console.log(`DISAGREEMENTS=${JSON.stringify(disagreements)}`);
  console.log(`RECOMMENDATION=${passed ? 'GO_FULL_BENCHMARK' : 'KEEP_SHADOW_ONLY'}`);
}

await main();
