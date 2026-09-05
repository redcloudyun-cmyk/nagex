import { AgexError } from '../common/errors.js';

export type ProviderTrustClass = 'PRIVATE' | 'DIRECT_APPROVED' | 'ENTERPRISE_APPROVED' | 'AGGREGATOR';
export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export interface ModelCandidate {
  model_id: string;
  provider_id: string;
  provider_class: ProviderTrustClass;
  capabilities: string[];
  supported_classifications: DataClassification[];
  region: string[];
  latency_ms: number;
  healthy: boolean;
  cost_per_1k_tokens: number;
}

export interface ModelRoutingRequest {
  required_capabilities: string[];
  data_classification: DataClassification;
  target_region?: string;
  max_cost_budget?: number;
}

// S-04 §2 step 6 (Provider Trust Class) ordering: more trusted providers
// must outrank less trusted ones, and per S-04 §2's core rule ("Cost가
// Security보다 앞설 수 없습니다") this ranking must be applied before the
// latency/cost tie-breakers (steps 8-9).
const PROVIDER_TRUST_RANK: Record<ProviderTrustClass, number> = {
  PRIVATE: 0,
  DIRECT_APPROVED: 1,
  ENTERPRISE_APPROVED: 2,
  AGGREGATOR: 3,
};

export class ModelRouter {
  private candidates: ModelCandidate[];

  constructor(candidates: ModelCandidate[]) {
    this.candidates = candidates;
  }

  public selectModel(request: ModelRoutingRequest): ModelCandidate {
    // 1. Required Capability Filter
    let filtered = this.candidates.filter(m =>
      request.required_capabilities.every(cap => m.capabilities.includes(cap))
    );

    if (filtered.length === 0) {
      throw new AgexError({
        code: 'NO_CAPABLE_MODEL_FOUND',
        category: 'PROVIDER',
        message: 'No model satisfies required capabilities.',
        request_id: 'mdl_req',
      });
    }

    // 2. Data Classification Filter
    filtered = filtered.filter(m =>
      m.supported_classifications.includes(request.data_classification)
    );

    if (filtered.length === 0) {
      throw new AgexError({
        code: 'DATA_CLASSIFICATION_DENIED',
        category: 'POLICY',
        message: `No model allowed for classification: ${request.data_classification}.`,
        request_id: 'mdl_req',
      });
    }

    // 3. Provider Health Filter
    filtered = filtered.filter(m => m.healthy);

    if (filtered.length === 0) {
      throw new AgexError({
        code: 'ALL_PROVIDERS_UNHEALTHY',
        category: 'PROVIDER',
        message: 'All matching model providers are currently unhealthy.',
        request_id: 'mdl_req',
      });
    }

    // 4. Region / Data Residency Filter (S-04 §2 step 5). Like every filter
    // above, this is a hard constraint: silently ignoring it when no
    // candidate matches would leak data outside its required residency.
    if (request.target_region) {
      filtered = filtered.filter(m => m.region.includes(request.target_region!));

      if (filtered.length === 0) {
        throw new AgexError({
          code: 'REGION_CONSTRAINT_VIOLATED',
          category: 'POLICY',
          message: `No model available in required region: ${request.target_region}.`,
          request_id: 'mdl_req',
        });
      }
    }

    // 5. Provider Trust Class (S-04 §2 step 6), then Health/Latency (step 8)
    // then Cost (step 9). S-04 does not yet define a hard minimum trust
    // class per data_classification, so this is a soft ranking preference
    // rather than an exclusion.
    // TODO(spec-gap): add a per-classification minimum provider_class
    // policy once one is specified (e.g. RESTRICTED forbidding AGGREGATOR).
    filtered.sort((a, b) =>
      PROVIDER_TRUST_RANK[a.provider_class] - PROVIDER_TRUST_RANK[b.provider_class] ||
      a.latency_ms - b.latency_ms ||
      a.cost_per_1k_tokens - b.cost_per_1k_tokens
    );

    return filtered[0];
  }
}
