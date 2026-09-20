import { NagexError } from '../common/errors.js';
import type { ModelProvider, RoutingMode } from './model-provider.js';
import type { ModelRoutingContext, ModelRoutingDecision } from './model-routing.types.js';

const STATUS_RANK: Record<string, number> = {
  LIVE: 0,
  CONFIGURED: 1,
  DEGRADED: 2,
  UNCONFIGURED: 3,
};

export class ModelRoutingPolicy {
  public select(
    mode: RoutingMode,
    context: ModelRoutingContext,
    providers: ModelProvider[],
    configuredPriority: string[] = []
  ): ModelRoutingDecision {
    const providerMap = new Map<string, ModelProvider>(providers.map((p) => [p.name, p]));
    const reasonCodes: string[] = ['TASK_SUPPORTED'];

    if (context.requiresJson) {
      reasonCodes.push('JSON_MODE_REQUIRED');
    }

    // 1. Explicit Provider Override
    if (mode !== 'auto') {
      const explicit = providerMap.get(mode);
      if (!explicit) {
        throw new NagexError({
          code: 'MODEL_PROVIDER_NOT_REGISTERED',
          category: 'VALIDATION',
          message: `Model provider is not registered: ${mode}.`,
          request_id: context.requestId,
        });
      }

      reasonCodes.push('EXPLICIT_OVERRIDE');

      // Remaining configured providers in fallback order
      const remainingCandidates = providers.filter(
        (p) => p.name !== mode && p.status().configured
      );

      return {
        taskKind: context.taskKind,
        selectedProvider: mode,
        fallbackProviders: remainingCandidates.map((p) => p.name),
        reasonCodes,
      };
    }

    // 2. Auto Routing: Filter configured providers
    const configuredProviders = providers.filter((p) => p.status().configured);
    if (configuredProviders.length === 0) {
      throw new NagexError({
        code: 'NO_MODEL_PROVIDER_CONFIGURED',
        category: 'PROVIDER',
        message: 'No model provider is configured.',
        request_id: context.requestId,
      });
    }

    // 3. Filter by required capabilities
    const eligibleProviders = configuredProviders.filter((provider) => {
      const caps = provider.capabilities;
      if (!caps) return true; // Default fallback if no caps object present

      if (context.requiresJson && !caps.supportsJsonMode) {
        return false;
      }
      if (context.taskKind === 'STRUCTURED_EXTRACTION' && !caps.supportsStructuredExtraction) {
        return false;
      }
      if (context.taskKind === 'CHAT' && !caps.supportsGeneralChat) {
        return false;
      }
      return true;
    });

    if (eligibleProviders.length === 0) {
      throw new NagexError({
        code: 'NO_MODEL_PROVIDER_CONFIGURED',
        category: 'PROVIDER',
        message: 'No model provider satisfies required capabilities.',
        request_id: context.requestId,
      });
    }

    // Check if any provider was degraded to record reason code
    const hasDegraded = eligibleProviders.some((p) => p.status().status === 'DEGRADED');
    if (hasDegraded) {
      reasonCodes.push('PROVIDER_DEGRADED_DEPRIORITIZED');
    }

    // Priority index mapping for tie-breaking
    const priorityIndexMap = new Map<string, number>();
    configuredPriority.forEach((name, idx) => priorityIndexMap.set(name, idx));

    // 4. Deterministic sorting: Runtime Status Tier -> Configured Priority Tie-Breaker
    const sortedCandidates = [...eligibleProviders].sort((a, b) => {
      const statusA = STATUS_RANK[a.status().status] ?? 3;
      const statusB = STATUS_RANK[b.status().status] ?? 3;
      if (statusA !== statusB) {
        return statusA - statusB;
      }

      const rankA = priorityIndexMap.has(a.name) ? priorityIndexMap.get(a.name)! : 999;
      const rankB = priorityIndexMap.has(b.name) ? priorityIndexMap.get(b.name)! : 999;
      return rankA - rankB;
    });

    const selected = sortedCandidates[0];
    const selectedStatus = selected.status().status;

    if (selectedStatus === 'LIVE') {
      reasonCodes.push('PROVIDER_LIVE');
    } else if (selectedStatus === 'CONFIGURED') {
      reasonCodes.push('PROVIDER_CONFIGURED');
    }

    reasonCodes.push('CONFIGURED_PRIORITY');

    return {
      taskKind: context.taskKind,
      selectedProvider: selected.name,
      fallbackProviders: sortedCandidates.slice(1).map((p) => p.name),
      reasonCodes: [...new Set(reasonCodes)],
    };
  }
}
