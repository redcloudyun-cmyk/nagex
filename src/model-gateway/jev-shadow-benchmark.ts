import { ModelRoutingPolicy } from './model-routing-policy.js';
import type { ModelProvider, ProviderStatus } from './model-provider.js';
import type { ModelProviderCapabilities, ModelTaskKind } from './model-routing.types.js';
import { JevShadowEvaluator } from './jev-shadow-evaluator.js';
import { JEV_SHADOW_FIXTURES, type JevShadowFixture } from './jev-shadow-fixtures.js';
import type { JevComplexity } from './jev-shadow.types.js';

export interface JevShadowBenchmarkResult {
  fixtureCount: number;
  accuracy: number;
  falseDowngradeRate: number;
  falseUpgradeRate: number;
  uncertainRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  projectedNemotronCallReduction: number;
  currentRouterOutputChangedByJev: number;
  baselineNemotronSelections: number;
}

class BenchmarkProvider implements ModelProvider {
  public readonly capabilities: ModelProviderCapabilities;

  constructor(
    public readonly name: string,
    public readonly model: string,
    private readonly eligibleTaskKinds?: ModelTaskKind[]
  ) {
    this.capabilities = {
      provider: name,
      supportsJsonMode: name !== 'openai',
      supportsGeneralChat: name !== 'nebius' || Boolean(eligibleTaskKinds),
      supportsStructuredExtraction: name !== 'nebius',
      ...(eligibleTaskKinds ? { eligibleTaskKinds } : {}),
    };
  }

  public status(): ProviderStatus {
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

  public async generate(): Promise<never> {
    throw new Error('BenchmarkProvider does not perform model calls.');
  }
}

const highComplexities = new Set<JevComplexity>(['HIGH_REASONING']);
const downgradeComplexities = new Set<JevComplexity>(['SIMPLE', 'STANDARD']);
const upgradeComplexities = new Set<JevComplexity>(['HIGH_REASONING']);

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function baselineDecision(fixture: JevShadowFixture, policy: ModelRoutingPolicy, providers: ModelProvider[]) {
  return policy.select(
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
}

export function runJevShadowBenchmark(input: {
  fixtures?: JevShadowFixture[];
  evaluator?: Pick<JevShadowEvaluator, 'evaluate'>;
} = {}): JevShadowBenchmarkResult {
  const fixtures = input.fixtures ?? JEV_SHADOW_FIXTURES;
  const evaluator = input.evaluator ?? new JevShadowEvaluator();
  const policy = new ModelRoutingPolicy();
  const providers: ModelProvider[] = [
    new BenchmarkProvider('nebius', 'nvidia/Nemotron-3_5-Lightning', ['PLAN', 'RESEARCH_SYNTHESIS', 'MEETING_PREP']),
    new BenchmarkProvider('gemini', 'gemini-benchmark'),
    new BenchmarkProvider('openai', 'gpt-benchmark'),
  ];

  let correct = 0;
  let falseDowngrades = 0;
  let highGold = 0;
  let falseUpgrades = 0;
  let lowGold = 0;
  let uncertain = 0;
  let baselineNemotronSelections = 0;
  let projectedNemotronAvoided = 0;
  const latencies: number[] = [];

  for (const fixture of fixtures) {
    const baseline = baselineDecision(fixture, policy, providers);
    const out = evaluator.evaluate({
      taskKind: fixture.taskKind,
      requiresJson: fixture.requiresJson,
      requiresEvidenceGrounding: fixture.requiresEvidenceGrounding,
      signals: fixture.signals,
    });
    latencies.push(out.latencyMs);
    if (
      out.complexity === fixture.expectedComplexity
      && out.reasonCode === fixture.expectedReasonCode
      && out.reasoningLevel === fixture.expectedReasoningLevel
      && ((out.highRiskProbability ?? 0) >= 0.7 ? 'HIGH' : 'LOW') === fixture.expectedRiskClass
    ) correct++;
    if (out.complexity === 'UNCERTAIN') uncertain++;

    if (highComplexities.has(fixture.expectedComplexity) || fixture.expectedRiskClass === 'HIGH') {
      highGold++;
      if (downgradeComplexities.has(out.complexity) && (out.highRiskProbability ?? 0) < 0.7) falseDowngrades++;
    } else if (fixture.expectedComplexity !== 'UNCERTAIN') {
      lowGold++;
      if (upgradeComplexities.has(out.complexity) || (out.highRiskProbability ?? 0) >= 0.7) falseUpgrades++;
    }

    if (baseline.selectedProvider === 'nebius') {
      baselineNemotronSelections++;
      if (out.complexity === 'SIMPLE' || out.complexity === 'STANDARD') projectedNemotronAvoided++;
    }
  }

  return {
    fixtureCount: fixtures.length,
    accuracy: correct / fixtures.length,
    falseDowngradeRate: highGold === 0 ? 0 : falseDowngrades / highGold,
    falseUpgradeRate: lowGold === 0 ? 0 : falseUpgrades / lowGold,
    uncertainRate: uncertain / fixtures.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    projectedNemotronCallReduction: baselineNemotronSelections === 0 ? 0 : projectedNemotronAvoided / baselineNemotronSelections,
    currentRouterOutputChangedByJev: 0,
    baselineNemotronSelections,
  };
}
