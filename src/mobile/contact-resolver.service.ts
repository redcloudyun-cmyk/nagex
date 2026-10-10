import { NagexError } from '../common/errors.js';
import type { RecipientRefStore } from './recipient-ref.store.js';
import type { ContactResolutionResult, MobileContactCandidateInput } from './contact-resolution.types.js';

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function exactNameMatch(spokenName: string, displayName: string): boolean {
  const a = normalizeName(spokenName);
  const b = normalizeName(displayName);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const costs = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    let last = i;
    costs[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const old = costs[j + 1] ?? 0;
      costs[j + 1] = Math.min((costs[j + 1] ?? 0) + 1, (costs[j] ?? 0) + 1, last + (a[i] === b[j] ? 0 : 1));
      last = old;
    }
  }
  return costs[b.length] ?? 0;
}

function nameSimilarity(spokenName: string, displayName: string): number {
  const a = normalizeName(spokenName);
  const b = normalizeName(displayName);
  if (!a || !b) return 0;
  const comparable = b.length > a.length ? b.slice(0, a.length) : b;
  const distance = levenshtein(a, comparable);
  return 1 - distance / Math.max(a.length, comparable.length, 1);
}

export class ContactResolver {
  constructor(private readonly recipientRefs: RecipientRefStore) {}

  public resolve(input: {
    tenantId: string;
    ownerId: string;
    deviceId: string;
    spokenName: string;
    candidates: MobileContactCandidateInput[];
    requestId: string;
  }): ContactResolutionResult {
    const spokenName = input.spokenName.trim();
    if (!spokenName) {
      throw new NagexError({ code: 'MOBILE_CONTACT_SPOKEN_NAME_REQUIRED', category: 'VALIDATION', message: 'spokenName is required.', request_id: input.requestId });
    }

    const exact = input.candidates.filter((candidate) => exactNameMatch(spokenName, candidate.displayName));
    const scored = input.candidates
      .map((candidate) => ({ candidate, similarity: nameSimilarity(spokenName, candidate.displayName) }))
      .filter((entry) => entry.similarity >= 0.66)
      .sort((a, b) => b.similarity - a.similarity);

    const matched = exact.length > 0 ? exact : scored.map((entry) => entry.candidate);
    if (matched.length === 0) return { status: 'NOT_FOUND' };

    if (matched.length > 1) {
      const distinctContactIds = new Set(matched.map((candidate) => candidate.contactId));
      if (distinctContactIds.size > 1) {
        return { status: 'AMBIGUOUS', candidates: matched };
      }
    }

    const unique = matched[0];
    const similarity = exact.length > 0 ? 1 : (scored.find((entry) => entry.candidate.contactId === unique.contactId)?.similarity ?? 0);
    if (exact.length === 0) {
      const runnerUp = scored[1]?.similarity ?? 0;
      if (similarity < 0.66 || similarity - runnerUp < 0.15) {
        return { status: scored.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: scored.map((entry) => entry.candidate) };
      }
    }

    const record = this.recipientRefs.mintOrReuse({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      androidContactId: unique.contactId,
      displayName: unique.displayName,
    });

    return {
      status: 'UNIQUE',
      recipientRef: record.recipientRef,
      displayName: record.displayName,
      matchKind: exact.length > 0 ? 'EXACT' : 'STRONG_SIMILARITY',
      similarity,
      confirmationRequired: exact.length === 0,
    };
  }
}
