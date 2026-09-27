// R23.6E Phase D Section 6 — recipient resolution.
// Order: (1) explicit recipientEmail from the request, (2) the currently
// authenticated user's own VERIFIED account email, (3) BLOCK. Never infers
// an address from memory, webpage content, model output, or a display
// name — those are exactly the un-authoritative sources Section 6
// forbids. No new contact system: this reads the existing IdentityStore
// record only.
export interface VerifiedIdentityLookup {
  getByUserId(userId: string): { email: string; verificationStatus: string; accountState: string } | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailFormat(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function resolveRecipientEmail(explicit: string | null, ownerId: string, identityLookup: VerifiedIdentityLookup): string | null {
  if (explicit && isValidEmailFormat(explicit)) {
    return explicit.trim();
  }

  const identity = identityLookup.getByUserId(ownerId);
  if (identity && identity.verificationStatus === 'VERIFIED' && identity.accountState === 'ACTIVE' && isValidEmailFormat(identity.email)) {
    return identity.email;
  }

  return null;
}
