// R23.6M Phase B3 — Contact Resolution contract.
//
// Privacy boundary (R23.6M design directive, Section "Contact
// Resolution"/"canonical recipientRef"): the Android app never uploads its
// full address book. It sends only candidate records it has already
// filtered down to ones plausibly relevant to the spoken name, and it
// never sends a phone number — only an opaque, device-local contactId and
// a display name. The actual contactId -> phone number mapping is resolved
// on-device, at execution time (Phase C), never here.
export interface MobileContactCandidateInput {
  // Opaque to the server — whatever the Android ContactsContract query
  // returned as that contact's local identifier. Never a phone number.
  contactId: string;
  displayName: string;
}

export function isMobileContactCandidateInput(value: unknown): value is MobileContactCandidateInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.contactId === 'string' && v.contactId.trim().length > 0
    && typeof v.displayName === 'string' && v.displayName.trim().length > 0;
}

export type ContactResolutionStatus = 'UNIQUE' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface ContactResolutionResult {
  status: ContactResolutionStatus;
  // Present only when status === 'UNIQUE'. The one and only way a
  // recipientRef is minted — see contact-resolver.service.ts.
  recipientRef?: string;
  displayName?: string;
  // Present only when status === 'AMBIGUOUS' — the matching candidates,
  // for the caller to present as a clarification choice. Never includes a
  // recipientRef per candidate; one is only minted once the user picks.
  candidates?: MobileContactCandidateInput[];
}

// The durable, opaque mapping a recipientRef resolves to. Deliberately
// carries no phone number — only what the server itself needs to bind a
// future message-send approval and re-display the recipient's name. The
// device-local contactId -> phone number lookup happens only on the
// Android device itself, at execution time.
export interface MobileRecipientRefRecord {
  recipientRef: string;
  tenantId: string;
  ownerId: string;
  deviceId: string;
  androidContactId: string;
  displayName: string;
  createdAt: string;
}

export function isMobileRecipientRefRecord(value: unknown): value is MobileRecipientRefRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.recipientRef === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.deviceId === 'string'
    && typeof v.androidContactId === 'string'
    && typeof v.displayName === 'string'
    && typeof v.createdAt === 'string';
}
