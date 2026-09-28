// R23.6M Phase B3 — server-side contact resolution.
//
// The Android app is untrusted-content-adjacent here in one specific
// sense: it has already filtered its own address book down to candidates
// it THINKS are relevant, but that filtering happens on a device the
// server does not control. The server never simply trusts "there's only
// one candidate in the list, so it must be right" — it independently
// re-checks every candidate's displayName against the spoken name before
// treating a single remaining match as unique. A spoken name, an LLM's
// guess at a name, or arbitrary app/page text can therefore never become a
// recipientRef by itself — only a candidate that both (a) the device
// proposed and (b) the server's own match check confirms, and even then
// only through RecipientRefStore.mintOrReuse(), the one and only place a
// recipientRef is ever created.
import { NagexError } from '../common/errors.js';
import type { RecipientRefStore } from './recipient-ref.store.js';
import type { ContactResolutionResult, MobileContactCandidateInput } from './contact-resolution.types.js';

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

// Deliberately simple and deterministic — no fuzzy/model-based matching.
// A spoken name matches a candidate's display name if, after
// case/whitespace normalization, one contains the other. This tolerates
// "김대진" matching "김대진 대표" (title suffix) or "Alex" matching "Alex Kim"
// without inventing similarity scoring that could paper over a genuinely
// wrong match.
function matchesSpokenName(spokenName: string, displayName: string): boolean {
  const a = normalizeName(spokenName);
  const b = normalizeName(displayName);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
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

    // The server independently re-filters — never trusts the device's own
    // candidate list at face value, however short it is.
    const matched = input.candidates.filter((c) => matchesSpokenName(spokenName, c.displayName));

    if (matched.length === 0) {
      // Fail closed: no candidate, or no candidate that actually matches
      // the spoken name, is NOT_FOUND — never a best-effort guess at the
      // "closest" candidate.
      return { status: 'NOT_FOUND' };
    }

    if (matched.length > 1) {
      // Deduplicate identical (contactId) entries the device may have sent
      // twice, but a genuine multiple-distinct-contact match is ambiguous.
      const distinctContactIds = new Set(matched.map((c) => c.contactId));
      if (distinctContactIds.size > 1) {
        return { status: 'AMBIGUOUS', candidates: matched };
      }
    }

    const unique = matched[0];
    const record = this.recipientRefs.mintOrReuse({
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      androidContactId: unique.contactId,
      displayName: unique.displayName,
    });

    return { status: 'UNIQUE', recipientRef: record.recipientRef, displayName: record.displayName };
  }
}
