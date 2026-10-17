// Image generation routes, discovered from the providers that are REGISTERED (the same ImageProviderPort adapters the creation module uses - nothing here is a second list of providers).
//
// Every fact is read from the adapter (its status, its capability descriptor, its model) or from the outcome ledger (what NAgex has seen it do). What NAgex cannot know stays unknown: no adapter publishes a
// price, so the cost of an image route is `unknown`, never a guess. Who would receive the data is NAgex's own conservative declaration (the table below): a provider id that is not in it is treated as an
// unknown third party that may receive only the lowest-sensitivity data - unknown is never promoted to trusted.
import type { ImageProviderPort } from '../creation/providers/creation-provider.types.js';
import { routeIdOf, type AuthStatus, type AvailabilityStatus, type ProcessingLocation, type RouteCandidate, type SensitivityClass } from './route-candidate.js';
import type { RouteOutcomeLedger } from './route-outcome-ledger.js';
import { QUOTA_COOLDOWN_MS } from './route-selection.js';

interface VendorTerms { vendorId: string; label: string; processing: ProcessingLocation; maxSensitivity: SensitivityClass; region: string | null }

/** NAgex's own declaration of where it will send what. It is not a statement about any vendor's practices (retention, training and regions are not known and are not claimed). */
const KNOWN_VENDORS: Record<string, VendorTerms> = {
  google: { vendorId: 'google', label: 'Google', processing: 'THIRD_PARTY_CLOUD', maxSensitivity: 'S1', region: null },
  openai: { vendorId: 'openai', label: 'OpenAI', processing: 'THIRD_PARTY_CLOUD', maxSensitivity: 'S1', region: null },
  'nvidia-nim': { vendorId: 'nvidia', label: 'NVIDIA', processing: 'THIRD_PARTY_CLOUD', maxSensitivity: 'S1', region: null },
  // an endpoint the operator runs: the data stays with the operator
  'local-gpu': { vendorId: 'operator-local', label: 'a local image service', processing: 'PRIVATE_ENDPOINT', maxSensitivity: 'S2', region: null },
};

export function vendorTermsOf(providerId: string): VendorTerms {
  // a second model of the same service registers as `google/<model>`: the same company, the same terms
  const base = providerId.split('/')[0].toLowerCase();
  return KNOWN_VENDORS[providerId.toLowerCase()] ?? KNOWN_VENDORS[base] ?? { vendorId: base, label: providerId, processing: 'THIRD_PARTY_CLOUD', maxSensitivity: 'S0', region: null };
}

function statusOf(status: ReturnType<ImageProviderPort['getStatus']>): { auth: AuthStatus; availability: AvailabilityStatus } {
  switch (status) {
    case 'AVAILABLE': case 'CONFIGURED': return { auth: 'CONFIGURED', availability: 'AVAILABLE' };
    case 'DEGRADED': return { auth: 'CONFIGURED', availability: 'DEGRADED' };
    case 'UNAVAILABLE': return { auth: 'CONFIGURED', availability: 'UNAVAILABLE' };
    default: return { auth: 'UNCONFIGURED', availability: 'UNAVAILABLE' };
  }
}

export function describeImageRoute(provider: ImageProviderPort, ledger?: RouteOutcomeLedger | null, now: () => number = Date.now): RouteCandidate {
  const terms = vendorTermsOf(provider.providerId);
  const caps = provider.getCapabilities();
  const model = provider.getModelId ? provider.getModelId() : null;
  const routeId = routeIdOf('IMAGE_GENERATION', provider.providerId, model);
  const { auth, availability } = statusOf(provider.getStatus());
  const exhaustedAt = ledger?.quotaExhaustedAt(routeId) ?? null;
  return {
    routeId, capability: 'IMAGE_GENERATION', provider: provider.providerId, model,
    label: model && provider.providerId.indexOf('/') >= 0 ? `${terms.label} (${model})` : terms.label,
    inputs: caps.referenceImageConditioning ? ['TEXT', 'IMAGE'] : ['TEXT'],
    outputs: ['IMAGE'],
    limits: { aspectRatios: caps.supportedAspectRatios, maxReferenceImages: caps.maxReferenceImages },
    auth, availability,
    // exhausted only while the cool-down lasts; afterwards the route is tried again (a success clears the record, another refusal restarts the cool-down)
    quota: exhaustedAt && now() - Date.parse(exhaustedAt) < QUOTA_COOLDOWN_MS ? 'EXHAUSTED' : 'UNKNOWN',
    quotaExhaustedAt: exhaustedAt,
    // no adapter publishes a price: it is not known, and is reported as not known
    cost: { usd: null, unknown: true, basis: 'UNKNOWN' },
    dataHandling: { processing: terms.processing, vendorId: terms.vendorId, maxSensitivity: terms.maxSensitivity, region: terms.region },
    approval: { required: true, reason: 'moving work to another service can change who receives the data and what it costs' },
    executionRoute: terms.processing === 'LOCAL_DEVICE' || terms.processing === 'PRIVATE_ENDPOINT' ? 'LOCAL_PROCESS' : 'API',
    reliability: ledger?.reliabilityOf(routeId) ?? null,
  };
}

export function imageRoutesOf(providers: ImageProviderPort[], ledger?: RouteOutcomeLedger | null, now: () => number = Date.now): RouteCandidate[] {
  return providers.map((p) => describeImageRoute(p, ledger, now));
}
