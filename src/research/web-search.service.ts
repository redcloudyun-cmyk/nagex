import { HttpWebSearchProvider } from './providers/http-web-search.provider.js';
import { TavilyWebSearchProvider } from './providers/tavily-web-search.provider.js';
import { OpenKnowledgeSearchProvider } from './providers/open-knowledge-search.provider.js';
import type { SearchQueryInput, SearchQueryResult, WebSearchProviderPort } from './web-search-provider.port.js';
import { sanitizeTextForSearchQuery } from '../context/sensitivity.detector.js';
import { RecoveryPlanner } from '../adaptive/recovery-planner.js';
import type { RouteAdvisor } from '../adaptive/route-advisor.js';
import type { StandingAuthorization } from '../adaptive/route-candidate.js';
import { InMemoryOutcomeMemory, searchVendorOf, searchWithRecovery, type OutcomeMemory } from './search-recovery.js';

export type SearchCapabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED';

export interface WebSearchServiceOptions {
  /** alternative routes, in the operator's order, tried only when the first fails in a way that allows another route */
  fallbacks?: WebSearchProviderPort[];
  /** what NAgex has seen each route do (quota cool-down, credential rejection, reliability); process-local by default */
  memory?: OutcomeMemory;
  /** an OPTIONAL advisory ranking of the eligible alternatives (JEV); the deterministic order stands without it */
  advisor?: RouteAdvisor | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function providerByName(name: string): WebSearchProviderPort | null {
  switch (name.toLowerCase()) {
    case 'tavily': return new TavilyWebSearchProvider();
    case 'open_knowledge': return new OpenKnowledgeSearchProvider({ enabled: true });
    case 'custom_http': case 'http': return new HttpWebSearchProvider();
    default: return null;
  }
}

/** The routes the OPERATOR configured: NAGEX_WEB_SEARCH_PROVIDER / the Tavily key choose the first; NAGEX_WEB_SEARCH_FALLBACKS (comma separated names) lists alternatives. Nothing is added on NAgex's own initiative. */
function configuredProviders(): { primary: WebSearchProviderPort; fallbacks: WebSearchProviderPort[] } {
  const providerType = (process.env.NAGEX_WEB_SEARCH_PROVIDER || '').toLowerCase();
  let primary: WebSearchProviderPort;
  if (providerType === 'tavily' || Boolean(process.env.NAGEX_TAVILY_API_KEY)) primary = new TavilyWebSearchProvider();
  else if (providerType === 'open_knowledge') primary = new OpenKnowledgeSearchProvider();
  else primary = new HttpWebSearchProvider();
  const fallbacks: WebSearchProviderPort[] = [];
  for (const raw of (process.env.NAGEX_WEB_SEARCH_FALLBACKS || '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name || name === primary.name.toLowerCase() || fallbacks.some((f) => f.name.toLowerCase() === name)) continue;
    const provider = providerByName(name);
    if (provider) fallbacks.push(provider);
  }
  return { primary, fallbacks };
}

export class WebSearchService {
  private readonly providers: WebSearchProviderPort[];
  private readonly memory: OutcomeMemory;
  private readonly planner: RecoveryPlanner;
  private readonly rejectedAuthUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(provider?: WebSearchProviderPort, options: WebSearchServiceOptions = {}) {
    if (provider) {
      this.providers = [provider, ...(options.fallbacks ?? [])];
    } else {
      const configured = configuredProviders();
      this.providers = [configured.primary, ...configured.fallbacks, ...(options.fallbacks ?? [])];
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.memory = options.memory ?? new InMemoryOutcomeMemory(this.now);
    this.planner = new RecoveryPlanner({ advisor: options.advisor ?? null });
  }

  public getProviderName(): string {
    return (this.providers.find((p) => p.isConfigured()) ?? this.providers[0]).name;
  }

  public isAvailable(): boolean {
    return this.providers.some((p) => p.isConfigured());
  }

  public getStatus(): SearchCapabilityStatus {
    return this.isAvailable() ? 'AVAILABLE' : 'UNAVAILABLE';
  }

  public status(): { configured: boolean; status: SearchCapabilityStatus; provider: string; routes: number } {
    const configured = this.isAvailable();
    return {
      configured,
      status: configured ? 'AVAILABLE' : 'UNAVAILABLE',
      provider: this.getProviderName(),
      routes: this.providers.filter((p) => p.isConfigured()).length,
    };
  }

  public sanitizeQuery(query: string): string {
    return sanitizeTextForSearchQuery(query);
  }

  /** The operator's alternatives with a known price of zero are the standing consent to move the (sanitized) question there; any other alternative needs the person. */
  private standing(): StandingAuthorization[] {
    return this.providers.slice(1)
      .filter((p) => p.isConfigured() && searchVendorOf(p.name).costUsd === 0)
      .map((p) => ({ capability: 'WEB_SEARCH' as const, allowedVendors: [searchVendorOf(p.name).vendorId], maxCostUsd: 0 }));
  }

  public async search(input: SearchQueryInput): Promise<SearchQueryResult> {
    if (!this.isAvailable()) {
      return {
        status: 'UNAVAILABLE',
        results: [],
        error: 'Web search provider is not configured or unavailable.',
        provider: this.providers[0].name,
      };
    }

    // Directive F: Re-use canonical sensitivity detector to strip S2/S3 secret markers or personal sensitive data before sending query
    const sanitizedQuery = this.sanitizeQuery(input.query);
    if (!sanitizedQuery.trim()) {
      return {
        status: 'NO_RESULTS',
        results: [],
        error: 'Query became empty after sensitivity sanitization.',
        provider: this.providers[0].name,
      };
    }

    return searchWithRecovery(
      { providers: this.providers, memory: this.memory, planner: this.planner, standing: this.standing(), rejectedAuthUntil: this.rejectedAuthUntil, now: this.now, sleep: this.sleep },
      { ...input, query: sanitizedQuery },
    );
  }
}
