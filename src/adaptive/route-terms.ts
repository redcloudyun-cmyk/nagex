// MATERIAL TERMS: what changes for the person when work moves from one route to another - and therefore when their consent has to be asked again.
//
// Switching routes is not free. It can change who receives the data, where it is processed, what it costs and what the result is. A change in any of those is MATERIAL: the original approval was given for
// the original terms and does not carry over. The only way around asking is a standing authorization the person gave explicitly in advance (none exists by default).
//
// Nothing here estimates "how much worse" an alternative is: quality is not measured, so it is not a term. What is unknown is reported as unknown.
import type { RouteCandidate, StandingAuthorization } from './route-candidate.js';

export type TermChangeKind =
  /** the data goes to a company that did not receive it before */
  | 'NEW_THIRD_PARTY_RECEIVES_DATA'
  | 'PROCESSING_LOCATION_CHANGED'
  | 'COST_INCREASED'
  /** the original price was known and the new one is not (or neither is known and a vendor changed) */
  | 'COST_UNKNOWN'
  | 'INPUT_TRANSFORMATION_NEEDED'
  /** the new route can see less of the input than the original (e.g. no reference images): the result is not the same kind of result */
  | 'INPUT_CAPABILITY_REDUCED';

export interface TermChange { kind: TermChangeKind; detail: string }

/** a small rise in a known price is not a new decision */
export const COST_TOLERANCE = 0.1;
const COST_EPSILON_USD = 0.005;

export function diffTerms(original: RouteCandidate | null, next: RouteCandidate): TermChange[] {
  const changes: TermChange[] = [];
  if (!original) {
    // nothing earlier to compare with: a first route whose terms are not already the person's is described, not diffed
    return changes;
  }
  if (next.dataHandling.vendorId !== original.dataHandling.vendorId) changes.push({ kind: 'NEW_THIRD_PARTY_RECEIVES_DATA', detail: `${next.dataHandling.vendorId} instead of ${original.dataHandling.vendorId}` });
  if (next.dataHandling.processing !== original.dataHandling.processing || (next.dataHandling.region !== original.dataHandling.region && (next.dataHandling.region !== null || original.dataHandling.region !== null))) {
    changes.push({ kind: 'PROCESSING_LOCATION_CHANGED', detail: `${original.dataHandling.processing}${original.dataHandling.region ? `/${original.dataHandling.region}` : ''} -> ${next.dataHandling.processing}${next.dataHandling.region ? `/${next.dataHandling.region}` : ''}` });
  }
  const before = original.cost.usd;
  const after = next.cost.usd;
  if (after === null || next.cost.unknown) {
    // an unknown price is a change when it replaces a known one, or when the company changes (a different price list that nobody has seen)
    if (before !== null || next.dataHandling.vendorId !== original.dataHandling.vendorId || next.model !== original.model) changes.push({ kind: 'COST_UNKNOWN', detail: 'the price of the other route is not known' });
  } else if (before === null) {
    if (after > COST_EPSILON_USD) changes.push({ kind: 'COST_INCREASED', detail: `a known price of $${after.toFixed(2)} where none was known` });
  } else if (after > before * (1 + COST_TOLERANCE) + COST_EPSILON_USD) {
    changes.push({ kind: 'COST_INCREASED', detail: `$${before.toFixed(2)} -> $${after.toFixed(2)}` });
  }
  const origRefs = original.limits.maxReferenceImages ?? 0;
  const nextRefs = next.limits.maxReferenceImages ?? 0;
  if (nextRefs < origRefs) changes.push({ kind: 'INPUT_CAPABILITY_REDUCED', detail: `reference images ${origRefs} -> ${nextRefs}` });
  return changes;
}

/** Every change listed above is material: each one is something the person would want to decide for themselves. */
export function isMaterial(changes: TermChange[]): boolean {
  return changes.length > 0;
}

/** True when an explicit standing authorization covers EVERY change of this switch (and only then may it happen without asking). */
export function coveredByStandingAuthorization(changes: TermChange[], next: RouteCandidate, standing: StandingAuthorization[] | undefined): boolean {
  if (!standing || standing.length === 0) return false;
  const grant = standing.find((s) => s.capability === next.capability && s.allowedVendors.includes(next.dataHandling.vendorId));
  if (!grant) return false;
  // the grant's ceiling applies to the route itself, whatever the changes are: a price above it, or one nobody knows, is never covered
  if (next.cost.unknown || next.cost.usd === null || next.cost.usd > grant.maxCostUsd) return false;
  for (const change of changes) {
    // a processing-location change, a reduction of what the route can take, a transformation of the input, and a price nobody knows are never covered by a vendor-and-ceiling grant
    if (change.kind === 'PROCESSING_LOCATION_CHANGED' || change.kind === 'INPUT_CAPABILITY_REDUCED' || change.kind === 'INPUT_TRANSFORMATION_NEEDED' || change.kind === 'COST_UNKNOWN') return false;
  }
  return true;
}

/** a stable fingerprint of the terms an approval is given for (binds the approval to exactly these) */
export function termsOf(candidate: RouteCandidate): Record<string, unknown> {
  return {
    routeId: candidate.routeId,
    vendorId: candidate.dataHandling.vendorId,
    processing: candidate.dataHandling.processing,
    region: candidate.dataHandling.region,
    maxSensitivity: candidate.dataHandling.maxSensitivity,
    costUsd: candidate.cost.usd,
    costUnknown: candidate.cost.unknown,
    costBasis: candidate.cost.basis,
  };
}
